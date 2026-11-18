package service

import (
	"context"
	"errors"
	"math/rand/v2"
	"slices"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/tokenkit"
	"github.com/gin-gonic/gin"
	"github.com/tidwall/gjson"
)

const autoPoolSelectionKey = "auto_pool_selection"
const autoPoolAttemptsKey = "auto_pool_attempted_members"
const autoPoolRequestContextKey = "auto_pool_request_context"

type AutoPoolSelection struct {
	Member      AutoPoolMember
	ActualModel string
	Lease       *AutoPoolLease
}

func GetAutoPoolSelection(c *gin.Context) *AutoPoolSelection {
	value, _ := c.Get(autoPoolSelectionKey)
	selection, _ := value.(*AutoPoolSelection)
	return selection
}

func ReleaseAutoPoolLease(c *gin.Context) {
	if selection := GetAutoPoolSelection(c); selection != nil {
		selection.Lease.Release()
	}
	// Each attempt needs a fresh child context. Releasing the old lease must
	// not cancel the base request or make the next retry immediately fail.
	if value, found := c.Get(autoPoolRequestContextKey); found {
		if ctx, ok := value.(context.Context); ok {
			c.Request = c.Request.WithContext(ctx)
		}
	}
}

type autoPoolCandidate struct {
	member  AutoPoolMember
	channel *model.Channel
	group   string
}

// SelectAutoPoolChannel does not bypass token model authorization. Call it only
// after the distributor validates access to llm-auto. Channel groups and pinned
// channel restrictions still apply, while session affinity intentionally does not.
func SelectAutoPoolChannel(c *gin.Context, alias string, group string) (*model.Channel, string, error) {
	ReleaseAutoPoolLease(c)
	autoPoolConfigMu.RLock()
	defer autoPoolConfigMu.RUnlock()
	config, err := GetAutoPoolConfig()
	if err != nil || !config.Enabled || alias != config.Model {
		return nil, group, errors.New("auto pool is disabled or invalid")
	}
	if c.Request.URL.Path != "/v1/chat/completions" && c.Request.URL.Path != "/pg/chat/completions" && c.Request.URL.Path != "/v1/responses" {
		return nil, group, errors.New("auto pool supports HTTP chat completions and responses only")
	}
	if !common.RedisEnabled || common.RDB == nil {
		return nil, group, errors.New("auto pool requires Redis")
	}
	body, err := common.GetBodyStorage(c)
	if err != nil {
		return nil, group, err
	}
	bytes, err := body.Bytes()
	if err != nil {
		return nil, group, err
	}
	if autoPoolUnsupportedMedia(bytes) {
		return nil, group, errors.New("auto pool supports text, tools and images; audio, video and file requests require an explicit model")
	}
	needsTools := autoPoolNeedsTools(bytes)
	needsVision := strings.Contains(string(bytes), `"image_url"`) || strings.Contains(string(bytes), `"input_image"`)
	var meta *types.TokenCountMeta
	var maxOutput uint
	if c.Request.URL.Path == "/v1/responses" {
		var request dto.OpenAIResponsesRequest
		if err := common.Unmarshal(bytes, &request); err != nil {
			return nil, group, errors.New("invalid auto pool request")
		}
		if request.MaxOutputTokens != nil {
			maxOutput = *request.MaxOutputTokens
		}
		meta = request.GetTokenCountMeta()
	} else {
		var request dto.GeneralOpenAIRequest
		if err := common.Unmarshal(bytes, &request); err != nil {
			return nil, group, errors.New("invalid auto pool request")
		}
		if request.MaxTokens != nil {
			maxOutput = *request.MaxTokens
		}
		if request.MaxCompletionTokens != nil {
			maxOutput = max(maxOutput, *request.MaxCompletionTokens)
		}
		meta = request.GetTokenCountMeta()
	}
	// Stateful Responses IDs bind context to a provider. Routing them randomly
	// would lose conversation state or expose another provider's opaque IDs.
	if gjson.GetBytes(bytes, "previous_response_id").String() != "" || gjson.GetBytes(bytes, "conversation").Exists() {
		return nil, group, errors.New("auto pool requires self-contained requests without provider conversation IDs")
	}
	groups := []string{group}
	if group == "auto" {
		groups = GetRequestAutoGroups(c, common.GetContextKeyString(c, constant.ContextKeyUserGroup))
	}
	constraints := GetChannelConstraints(c)
	filters := slices.Clone(constraints.Filters)
	for i := range filters {
		if filters[i].RequestPath == "/pg/chat/completions" {
			filters[i].RequestPath = "/v1/chat/completions"
		}
	}
	pin, pinned, _ := constraints.ResolvedPin()
	attempted := c.GetStringSlice(autoPoolAttemptsKey)
	candidates := make([]autoPoolCandidate, 0, len(config.Members))
	for _, member := range config.Members {
		if member.State != "accepting" || member.Weight == 0 || slices.Contains(attempted, member.ID) || (needsTools && !member.SupportsTools) || (needsVision && !member.SupportsVision) {
			continue
		}
		if pinned && pin.ChannelId != member.ChannelID {
			continue
		}
		if member.ContextWindow > 0 {
			// Finite-window routing currently supports text only: don't fetch
			// arbitrary media once per candidate or understate media tokens.
			if len(meta.Files) > 0 || maxOutput > uint(member.ContextWindow) {
				continue
			}
			input := tokenkit.Count(member.ActualModel, meta.CombineText)
			if c.Request.URL.Path != "/v1/responses" {
				input += meta.ToolsCount*8 + meta.MessagesCount*3 + meta.NameCount*3 + 3
			}
			if input > member.ContextWindow-int(maxOutput) {
				continue
			}
		}
		channel, err := model.CacheGetChannel(member.ChannelID)
		if err != nil || channel == nil || channel.Status != common.ChannelStatusEnabled {
			continue
		}
		channel, err = PrepareAutoPoolChannel(channel, member, c.Request.URL.Path)
		if err != nil {
			continue
		}
		if matches, _ := model.ChannelSatisfiesFilters(channel, member.SourceModel(), filters); !matches {
			continue
		}
		selectedGroup := ""
		for _, candidateGroup := range groups {
			if slices.Contains(channel.GetGroups(), candidateGroup) {
				selectedGroup = candidateGroup
				break
			}
		}
		if selectedGroup == "" {
			continue
		}
		if config.HealthEnabled {
			runtime, err := ReadAutoPoolHealth(config, member)
			if err != nil {
				return nil, group, errors.New("auto pool health service is unavailable")
			}
			if runtime.Health != "healthy" {
				continue
			}
		}
		candidates = append(candidates, autoPoolCandidate{member: member, channel: channel, group: selectedGroup})
	}
	for len(candidates) > 0 {
		totalWeight := 0
		for _, candidate := range candidates {
			totalWeight += candidate.member.Weight
		}
		ticket := rand.IntN(totalWeight)
		index := autoPoolWeightedIndex(candidates, ticket)
		candidate := candidates[index]
		candidates = append(candidates[:index], candidates[index+1:]...)
		lease, requestCtx, err := AcquireAutoPoolLease(c.Request.Context(), candidate.member, config.LeaseSeconds)
		if err != nil {
			return nil, group, err
		}
		if lease == nil {
			continue
		}
		c.Set(autoPoolAttemptsKey, append(attempted, candidate.member.ID))
		c.Set(autoPoolRequestContextKey, c.Request.Context())
		c.Request = c.Request.WithContext(requestCtx)
		c.Set(autoPoolSelectionKey, &AutoPoolSelection{Member: candidate.member, ActualModel: candidate.member.ActualModel, Lease: lease})
		if group == "auto" {
			common.SetContextKey(c, constant.ContextKeyAutoGroup, candidate.group)
		}
		return candidate.channel, candidate.group, nil
	}
	return nil, group, errors.New("no healthy, permitted auto pool member has available capacity")
}

func autoPoolWeightedIndex(candidates []autoPoolCandidate, ticket int) int {
	for i, candidate := range candidates {
		ticket -= candidate.member.Weight
		if ticket < 0 {
			return i
		}
	}
	return len(candidates) - 1
}

func autoPoolNeedsTools(body []byte) bool {
	if gjson.GetBytes(body, "tools.#").Int() > 0 || gjson.GetBytes(body, "functions.#").Int() > 0 {
		return true
	}
	for _, message := range gjson.GetBytes(body, "messages").Array() {
		role := message.Get("role").String()
		if role == "tool" || role == "function" || message.Get("tool_calls.#").Int() > 0 || message.Get("function_call").Exists() {
			return true
		}
	}
	for _, item := range gjson.GetBytes(body, "input").Array() {
		kind := item.Get("type").String()
		if strings.HasSuffix(kind, "_call") || strings.HasSuffix(kind, "_call_output") || kind == "mcp_approval_request" || kind == "mcp_approval_response" {
			return true
		}
	}
	return false
}

// The first pool contract only declares text/tools/vision capabilities. Do not
// let audio or file traffic enter a model chosen without matching capabilities
// and the corresponding model-specific billing path.
func autoPoolUnsupportedMedia(body []byte) bool {
	if audio := gjson.GetBytes(body, "audio"); audio.Exists() && audio.Type != gjson.Null {
		return true
	}
	for _, modality := range gjson.GetBytes(body, "modalities").Array() {
		if modality.String() == "audio" {
			return true
		}
	}
	for _, path := range []string{"messages", "input"} {
		for _, item := range gjson.GetBytes(body, path).Array() {
			if audio := item.Get("audio"); audio.Exists() && audio.Type != gjson.Null {
				return true
			}
			parts := append(item.Get("content").Array(), item)
			for _, part := range parts {
				switch part.Get("type").String() {
				case "input_audio", "output_audio", "audio", "audio_url", "input_video", "video", "video_url", "input_file", "file":
					return true
				}
			}
		}
	}
	return false
}
