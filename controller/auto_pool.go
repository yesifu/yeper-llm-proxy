package controller

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

type autoPoolChannelModel struct {
	Name        string `json:"name"`
	ActualModel string `json:"actual_model"`
}

type autoPoolChannelOption struct {
	ID                    int                    `json:"id"`
	Name                  string                 `json:"name"`
	Type                  int                    `json:"type"`
	Status                int                    `json:"status"`
	Models                []autoPoolChannelModel `json:"models"`
	Compatible            bool                   `json:"compatible"`
	IncompatibilityReason string                 `json:"incompatibility_reason"`
}

// appendAutoPoolModel exposes the virtual alias only through groups already
// authorized by the caller. Console selectors include unpriced models; the
// public model API additionally requires a billable underlying model.
// Discovery is independent of transient health, capacity and pause state.
func appendAutoPoolModel(models []string, groups []string, requirePrice bool) []string {
	if len(groups) == 0 || slices.Contains(models, service.AutoPoolModel) {
		return models
	}
	pool, err := service.GetAutoPoolConfig()
	if err != nil || !pool.Enabled {
		return models
	}
	for _, member := range pool.Members {
		channel, err := model.CacheGetChannel(member.ChannelID)
		if err != nil || channel == nil || channel.Status != common.ChannelStatusEnabled {
			continue
		}
		if !slices.ContainsFunc(groups, func(group string) bool { return slices.Contains(channel.GetGroups(), group) }) {
			continue
		}
		if _, _, err := service.PrepareAutoPoolProbeChannel(channel, member); err != nil {
			continue
		}
		if requirePrice && !helper.HasModelBillingConfig(member.ActualModel) {
			continue
		}
		return append(models, service.AutoPoolModel)
	}
	return models
}

func GetAutoPoolChannels(c *gin.Context) {
	var channels []model.Channel
	// Fetch only selection metadata. Credentials and upstream URLs are not
	// needed for the picker and must never be serialized into its response.
	err := model.DB.WithContext(c.Request.Context()).Select("id", "name", "type", "status", "models", "model_mapping", "setting", "param_override", "settings").Order("id ASC").Find(&channels).Error
	if err != nil {
		common.ApiErrorT(c, "Auto pool operation failed")
		return
	}
	options := make([]autoPoolChannelOption, 0, len(channels))
	for _, channel := range channels {
		option := autoPoolChannelOption{
			ID: channel.Id, Name: channel.Name, Type: channel.Type, Status: channel.Status,
			Models: []autoPoolChannelModel{}, IncompatibilityReason: autoPoolChannelUnavailableReason(&channel),
		}
		mappingContext := &gin.Context{}
		mappingContext.Set("model_mapping", channel.GetModelMapping())
		seen := map[string]bool{}
		hasTextRouteCandidate := false
		for _, name := range channel.GetModels() {
			name = strings.TrimSpace(name)
			if name == "" || name == service.AutoPoolModel || seen[name] {
				continue
			}
			seen[name] = true
			info := &relaycommon.RelayInfo{OriginModelName: name, ChannelMeta: &relaycommon.ChannelMeta{UpstreamModelName: name}}
			if err := helper.ModelMappedHelper(mappingContext, info, nil); err != nil {
				option.IncompatibilityReason = "invalid_model_mapping"
				option.Models = []autoPoolChannelModel{}
				break
			}
			actual := info.UpstreamModelName
			if actual == service.AutoPoolModel {
				continue
			}
			if actual == "" || actual != strings.TrimSpace(actual) || len(actual) > 256 || strings.ContainsAny(actual, "\r\n\t") {
				option.IncompatibilityReason = "invalid_model_mapping"
				option.Models = []autoPoolChannelModel{}
				break
			}
			hasTextRouteCandidate = true
			if option.IncompatibilityReason == "" {
				member := service.AutoPoolMember{ChannelID: channel.Id, ChannelModel: name, ActualModel: actual}
				if _, _, err := service.PrepareAutoPoolProbeChannel(&channel, member); err != nil {
					continue
				}
			}
			option.Models = append(option.Models, autoPoolChannelModel{Name: name, ActualModel: actual})
		}
		if option.IncompatibilityReason == "" && len(option.Models) == 0 {
			option.IncompatibilityReason = "no_models"
			if hasTextRouteCandidate {
				option.IncompatibilityReason = "unsupported_routes"
			}
		}
		option.Compatible = option.IncompatibilityReason == ""
		options = append(options, option)
	}
	common.ApiSuccess(c, options)
}

func autoPoolChannelUnavailableReason(channel *model.Channel) string {
	if channel.Status != common.ChannelStatusEnabled {
		return "disabled"
	}
	return service.AutoPoolChannelUnavailableReason(channel)
}

func GetAutoPool(c *gin.Context) {
	config, err := service.GetAutoPoolConfig()
	if err != nil {
		common.ApiErrorT(c, "Auto pool operation failed")
		return
	}
	common.ApiSuccess(c, gin.H{"config": config, "runtime": service.AutoPoolRuntimeSnapshot(config)})
}

func UpdateAutoPool(c *gin.Context) {
	var config service.AutoPoolConfig
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 512*1024)
	if err := common.DecodeJson(c.Request.Body, &config); err != nil {
		common.ApiErrorT(c, "Auto pool configuration is invalid: {{reason}}", map[string]any{"reason": "invalid JSON body"})
		return
	}
	if err := service.SaveAutoPoolConfig(config); err != nil {
		common.ApiErrorT(c, "Auto pool configuration is invalid: {{reason}}", map[string]any{"reason": err.Error()})
		return
	}
	GetAutoPool(c)
}

func ProbeAutoPoolMember(c *gin.Context) {
	config, err := service.GetAutoPoolConfig()
	if err != nil {
		common.ApiErrorT(c, "Auto pool operation failed")
		return
	}
	found := false
	for _, member := range config.Members {
		if member.ID == c.Param("id") {
			found = true
			break
		}
	}
	if !found {
		common.ApiErrorT(c, "Auto pool member was not found")
		return
	}
	if !probeAutoPoolMember(c.Request.Context(), config, c.Param("id")) {
		common.ApiErrorT(c, "Auto pool probe could not start")
		return
	}
	for _, runtime := range service.AutoPoolRuntimeSnapshot(config) {
		if runtime.ID == c.Param("id") {
			common.ApiSuccess(c, runtime)
			return
		}
	}
}

func probeAutoPoolMember(parent context.Context, config service.AutoPoolConfig, id string) bool {
	ctx, cancel := context.WithTimeout(parent, time.Duration(config.ProbeTimeoutSeconds)*time.Second)
	defer cancel()
	member, lease, leaseCtx, err := service.BeginAutoPoolProbe(ctx, id)
	if err != nil || lease == nil {
		return false
	}
	defer lease.Release()
	channel, err := model.CacheGetChannel(member.ChannelID)
	if err != nil || channel == nil || channel.Status != common.ChannelStatusEnabled {
		return false
	}
	probeChannel, endpointType, err := service.PrepareAutoPoolProbeChannel(channel, member)
	if err != nil {
		return false
	}
	userID, err := resolveChannelTestUserID(nil)
	if err != nil {
		return false
	}
	// Probe the terminal upstream model, using the same provider adapter as
	// real traffic. Disable mappings on this request-local copy only.
	probeChannel.ModelMapping = nil
	started := time.Now()
	result := testChannel(leaseCtx, probeChannel, userID, member.ActualModel, string(endpointType), false)
	healthy := result.localErr == nil && result.newAPIError == nil
	// Provider errors can contain URLs, keys and response bodies. The runtime
	// API retains only a generic failure reason and timing.
	return service.RecordAutoPoolHealth(member, healthy, time.Since(started)) == nil
}

var autoPoolHealthWorkerOnce sync.Once

const autoPoolHealthConcurrency = 16

func StartAutoPoolHealthWorker(ctx context.Context) {
	autoPoolHealthWorkerOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(5 * time.Second)
			defer ticker.Stop()
			runAutoPoolHealthWorker(ctx, ticker.C, service.GetAutoPoolConfig, probeAutoPoolMemberIfDue)
		}()
	})
}

// Health reads belong in the bounded workers too: an unavailable Redis must
// not serialize all probes behind one slow read in the scheduler.
func probeAutoPoolMemberIfDue(ctx context.Context, id string) bool {
	config, err := service.GetAutoPoolConfig()
	if err != nil || !config.Enabled || !config.HealthEnabled || ctx.Err() != nil {
		return false
	}
	for _, member := range config.Members {
		if member.ID != id || member.State != "accepting" {
			continue
		}
		runtime, err := service.ReadAutoPoolHealth(config, member)
		if err != nil || time.Now().Unix()-runtime.LastChecked < int64(config.ProbeIntervalSeconds) {
			return false
		}
		return probeAutoPoolMember(ctx, config, member.ID)
	}
	return false
}

// The scheduler owns all pending/attempt state. A member has at most one job
// across ticks; completed jobs immediately make room for other due members.
// The bounded queue and workers do not grow with upstream response times.
func runAutoPoolHealthWorker(ctx context.Context, ticks <-chan time.Time, loadConfig func() (service.AutoPoolConfig, error), probe func(context.Context, string) bool) {
	jobs := make(chan string, autoPoolHealthConcurrency)
	finished := make(chan string, autoPoolHealthConcurrency)
	var workers sync.WaitGroup
	for range autoPoolHealthConcurrency {
		workers.Go(func() {
			for {
				select {
				case <-ctx.Done():
					return
				case job, ok := <-jobs:
					if !ok || ctx.Err() != nil {
						return
					}
					probe(ctx, job)
					select {
					case finished <- job:
					case <-ctx.Done():
						return
					}
				}
			}
		})
	}
	defer workers.Wait()
	defer close(jobs)
	pending := make(map[string]bool)
	lastAttempt := make(map[string]time.Time)
	var queue []string
	refresh := true
	for {
		if ctx.Err() != nil {
			return
		}
		if refresh {
			queue = nil
			config, err := loadConfig()
			if err == nil {
				members := make(map[string]bool, len(config.Members))
				for _, member := range config.Members {
					members[member.ID] = true
					if config.Enabled && config.HealthEnabled && member.State == "accepting" && !pending[member.ID] && time.Since(lastAttempt[member.ID]) >= time.Duration(config.ProbeIntervalSeconds)*time.Second {
						queue = append(queue, member.ID)
					}
				}
				for id := range lastAttempt {
					if !members[id] && !pending[id] {
						delete(lastAttempt, id)
					}
				}
				slices.SortStableFunc(queue, func(a, b string) int {
					return lastAttempt[a].Compare(lastAttempt[b])
				})
			}
			refresh = false
		}
		for len(queue) > 0 && len(pending) < autoPoolHealthConcurrency {
			job := queue[0]
			queue = queue[1:]
			if pending[job] {
				continue
			}
			pending[job] = true
			jobs <- job
		}
		select {
		case <-ctx.Done():
			return
		case <-ticks:
			refresh = true
		case id := <-finished:
			delete(pending, id)
			// Even a capacity-rejected attempt waits an interval before retrying,
			// so a busy first member cannot starve later members.
			lastAttempt[id] = time.Now()
		}
	}
}
