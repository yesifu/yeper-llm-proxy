package service

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/model_setting"
)

const AutoPoolOptionKey = "AutoPoolConfig"
const AutoPoolModel = "llm-auto"

var autoPoolConfigMu sync.RWMutex
var autoPoolIdentifier = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`)

type AutoPoolConfig struct {
	Enabled              bool             `json:"enabled"`
	Model                string           `json:"model"`
	HealthEnabled        bool             `json:"health_enabled"`
	ProbeIntervalSeconds int              `json:"probe_interval_seconds"`
	ProbeTimeoutSeconds  int              `json:"probe_timeout_seconds"`
	LeaseSeconds         int              `json:"lease_seconds"`
	Members              []AutoPoolMember `json:"members"`
}

type AutoPoolMember struct {
	ID             string `json:"id"`
	ChannelID      int    `json:"channel_id"`
	ActualModel    string `json:"actual_model"`
	Weight         int    `json:"weight"`
	ResourceKey    string `json:"resource_key"`
	MaxConcurrency int    `json:"max_concurrency"`
	State          string `json:"state"`
	SupportsTools  bool   `json:"supports_tools"`
	SupportsVision bool   `json:"supports_vision"`
	ContextWindow  int    `json:"context_window"`
}

func IsAutoPoolModel(name string) bool { return name == AutoPoolModel }

func GetAutoPoolConfig() (AutoPoolConfig, error) {
	config := AutoPoolConfig{Model: AutoPoolModel, HealthEnabled: true, ProbeIntervalSeconds: 60, ProbeTimeoutSeconds: 20, LeaseSeconds: 120, Members: []AutoPoolMember{}}
	common.OptionMapRWMutex.RLock()
	value := common.OptionMap[AutoPoolOptionKey]
	common.OptionMapRWMutex.RUnlock()
	if value == "" {
		return config, nil
	}
	if err := common.UnmarshalJsonStr(value, &config); err != nil {
		return config, errors.New("invalid auto pool configuration")
	}
	if config.Members == nil {
		config.Members = []AutoPoolMember{}
	}
	return config, ValidateAutoPoolConfig(config)
}

func ValidateAutoPoolConfig(config AutoPoolConfig) error {
	if config.Model != AutoPoolModel {
		return errors.New("model must be llm-auto")
	}
	if config.ProbeIntervalSeconds < 15 || config.ProbeIntervalSeconds > 3600 || config.ProbeTimeoutSeconds < 1 || config.ProbeTimeoutSeconds > 120 || config.LeaseSeconds < 30 || config.LeaseSeconds > 3600 {
		return errors.New("probe interval must be 15–3600 seconds, timeout 1–120 seconds, and lease 30–3600 seconds")
	}
	if len(config.Members) > 256 {
		return errors.New("at most 256 pool members are supported")
	}
	ids := map[string]bool{}
	capacities := map[string]int{}
	for _, member := range config.Members {
		if !autoPoolIdentifier.MatchString(member.ID) || !autoPoolIdentifier.MatchString(member.ResourceKey) {
			return errors.New("member and resource identifiers must be 1–64 letters, digits, dots, underscores or hyphens")
		}
		if ids[member.ID] {
			return fmt.Errorf("duplicate member identifier: %s", member.ID)
		}
		ids[member.ID] = true
		if member.ChannelID < 1 || member.ActualModel == "" || member.ActualModel != strings.TrimSpace(member.ActualModel) || len(member.ActualModel) > 256 || member.ActualModel == AutoPoolModel || strings.ContainsAny(member.ActualModel, "\r\n\t") {
			return fmt.Errorf("member %s must name an existing channel and a terminal upstream model", member.ID)
		}
		if member.Weight < 0 || member.Weight > 10000 || member.MaxConcurrency < 1 || member.MaxConcurrency > 10000 || member.ContextWindow < 0 || member.ContextWindow > 10000000 {
			return fmt.Errorf("member %s has invalid weight, capacity or context window", member.ID)
		}
		if member.State != "accepting" && member.State != "draining" && member.State != "paused" {
			return fmt.Errorf("member %s has an invalid state", member.ID)
		}
		if capacity, found := capacities[member.ResourceKey]; found && capacity != member.MaxConcurrency {
			return fmt.Errorf("resource %s must use the same concurrency limit for every member", member.ResourceKey)
		}
		capacities[member.ResourceKey] = member.MaxConcurrency
	}
	return nil
}

// AutoPoolChannelCompatible prevents overrides from silently changing the
// selected model after its price has been reserved. Explicit alias mapping is
// installed by the gateway after selection, so existing model mappings are not
// used for pool requests.
func AutoPoolChannelCompatible(channel *model.Channel) bool {
	if channel == nil || model_setting.GetGlobalSettings().PassThroughRequestEnabled || channel.GetSetting().PassThroughBodyEnabled {
		return false
	}
	// Arbitrary parameter overrides and custom routes can replace model/body.
	if len(channel.GetParamOverride()) != 0 {
		return false
	}
	// vLLM and SGLang are implemented with immutable OpenAI-compatible route
	// presets. They still serialize the mapped request model, unlike arbitrary
	// administrator-defined custom routes.
	if common.GetAdvancedCustomPreset(channel.Type) != nil {
		return true
	}
	settings := channel.GetOtherSettings()
	return settings.AdvancedCustom == nil || len(settings.AdvancedCustom.Routes) == 0
}

func SaveAutoPoolConfig(config AutoPoolConfig) error {
	if config.Members == nil {
		config.Members = []AutoPoolMember{}
	}
	if err := ValidateAutoPoolConfig(config); err != nil {
		return err
	}
	autoPoolConfigMu.Lock()
	defer autoPoolConfigMu.Unlock()
	for _, member := range config.Members {
		channel, err := model.GetChannelById(member.ChannelID, true)
		if err != nil || channel == nil {
			return fmt.Errorf("channel for member %s does not exist", member.ID)
		}
		if !AutoPoolChannelCompatible(channel) {
			return fmt.Errorf("member %s requires a channel without passthrough, parameter overrides or custom routes", member.ID)
		}
	}
	previous, err := GetAutoPoolConfig()
	if err != nil {
		return err
	}
	// Drain before removing or moving members: otherwise a new resource key
	// could hide still-running requests from the capacity and reclamation UI.
	for _, old := range previous.Members {
		unchanged := false
		for _, member := range config.Members {
			if member.ID == old.ID && member.ResourceKey == old.ResourceKey && member.ChannelID == old.ChannelID && member.ActualModel == old.ActualModel {
				unchanged = true
				break
			}
		}
		if unchanged {
			continue
		}
		count, err := AutoPoolResourceInFlight(old.ResourceKey)
		if err != nil || count > 0 {
			return fmt.Errorf("drain resource %s and wait for zero active requests before changing its members", old.ResourceKey)
		}
	}
	encoded, err := common.Marshal(config)
	if err != nil {
		return err
	}
	// Unlike UpdateOption, the bulk path propagates persistence failures.
	return model.UpdateOptionsBulk(map[string]string{AutoPoolOptionKey: string(encoded)})
}
