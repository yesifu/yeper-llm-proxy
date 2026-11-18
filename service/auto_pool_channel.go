package service

import (
	"errors"
	"fmt"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/setting/model_setting"
)

// AutoPoolChannelUnavailableReason checks channel-wide settings without using
// getters that repair malformed persisted JSON. Route eligibility is checked
// separately for the chosen channel model and request endpoint.
func AutoPoolChannelUnavailableReason(channel *model.Channel) string {
	_, reason := autoPoolChannelSettings(channel)
	return reason
}

func AutoPoolChannelCompatible(channel *model.Channel) bool {
	return AutoPoolChannelUnavailableReason(channel) == ""
}

// autoPoolChannelSettings preserves the selected model's billing identity:
// raw-body forwarding and arbitrary parameter overrides could replace its
// serialized model after the gateway has reserved the actual model's price.
func autoPoolChannelSettings(channel *model.Channel) (dto.ChannelOtherSettings, string) {
	other := dto.ChannelOtherSettings{}
	if channel == nil {
		return other, "invalid_channel_settings"
	}
	settings := dto.ChannelSettings{}
	if channel.Setting != nil && *channel.Setting != "" {
		if err := common.UnmarshalJsonStr(*channel.Setting, &settings); err != nil {
			return other, "invalid_channel_settings"
		}
	}
	if model_setting.GetGlobalSettings().PassThroughRequestEnabled || settings.PassThroughBodyEnabled {
		return other, "passthrough"
	}
	parameters := map[string]any{}
	if channel.ParamOverride != nil && *channel.ParamOverride != "" {
		if err := common.UnmarshalJsonStr(*channel.ParamOverride, &parameters); err != nil {
			return other, "invalid_channel_settings"
		}
	}
	if len(parameters) > 0 {
		return other, "parameter_override"
	}
	if channel.OtherSettings != "" {
		if err := common.UnmarshalJsonStr(channel.OtherSettings, &other); err != nil {
			return other, "invalid_channel_settings"
		}
	}
	if preset := common.GetAdvancedCustomPreset(channel.Type); preset != nil {
		other.AdvancedCustom = preset
	}
	if constant.IsAdvancedCustomChannel(channel.Type) {
		if err := other.AdvancedCustom.Validate(); err != nil {
			return other, "invalid_channel_settings"
		}
	}
	return other, ""
}

// PrepareAutoPoolChannel keeps custom URL, authentication and protocol
// conversion settings while binding the request to the selected source model's
// route. Only the returned channel is changed; cached channel settings remain
// untouched. The distributor still maps llm-auto to member.ActualModel.
func PrepareAutoPoolChannel(channel *model.Channel, member AutoPoolMember, requestPath string) (*model.Channel, error) {
	other, reason := autoPoolChannelSettings(channel)
	if reason != "" {
		return nil, fmt.Errorf("channel is unavailable for auto pool: %s", reason)
	}
	if requestPath == "/pg/chat/completions" {
		requestPath = "/v1/chat/completions"
	}
	if requestPath != "/v1/chat/completions" && requestPath != "/v1/responses" {
		return nil, errors.New("auto pool supports HTTP chat completions and responses only")
	}
	prepared := *channel
	if !constant.IsAdvancedCustomChannel(channel.Type) {
		return &prepared, nil
	}
	route, matched := other.AdvancedCustom.MatchPathForModel(requestPath, member.SourceModel())
	if !matched {
		return nil, errors.New("channel has no compatible route for the selected model and endpoint")
	}
	if route.PassThroughBodyEnabled {
		return nil, errors.New("auto pool does not support body passthrough for the selected route")
	}
	// Model rules have already selected this route using the channel alias. The
	// relay still receives llm-auto as OriginModelName for authorization/logging.
	route.Models = nil
	route.IncomingPath = requestPath
	other.AdvancedCustom = &dto.AdvancedCustomConfig{Routes: []dto.AdvancedCustomRoute{route}}
	encoded, err := common.Marshal(other)
	if err != nil {
		return nil, err
	}
	prepared.OtherSettings = string(encoded)
	return &prepared, nil
}

// PrepareAutoPoolProbeChannel probes a supported text endpoint instead of
// assuming every custom channel provides Chat Completions.
func PrepareAutoPoolProbeChannel(channel *model.Channel, member AutoPoolMember) (*model.Channel, constant.EndpointType, error) {
	if channel != nil && !constant.IsAdvancedCustomChannel(channel.Type) {
		prepared, err := PrepareAutoPoolChannel(channel, member, "/v1/chat/completions")
		// Existing provider tests infer the endpoint from the channel/model;
		// for example Codex requires Responses. Only custom routes need an
		// explicit endpoint selected here.
		return prepared, "", err
	}
	if prepared, err := PrepareAutoPoolChannel(channel, member, "/v1/chat/completions"); err == nil {
		return prepared, constant.EndpointTypeOpenAI, nil
	}
	prepared, err := PrepareAutoPoolChannel(channel, member, "/v1/responses")
	if err != nil {
		return nil, "", err
	}
	return prepared, constant.EndpointTypeOpenAIResponse, nil
}
