package relay

import (
	"errors"
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/logger"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/samber/lo"
)

// PrepareRequestBilling estimates and reserves one request's charge. Transports
// provide the current request body through BodyStorage or BillingRequestInput;
// channel retries retain the resulting billing session and pricing snapshot.
func PrepareRequestBilling(c *gin.Context, info *relaycommon.RelayInfo) *types.NewAPIError {
	if selected := service.GetAutoPoolSelection(c); selected != nil {
		info.BillingModelName = selected.ActualModel
		c.Header("X-LLM-Model", selected.ActualModel)
		// Each attempt freezes the selected model's price independently.
		// Preserve the billing session so a retry reserves only a difference
		// and the final response settles/refunds the request exactly once.
		info.TieredBillingSnapshot = nil
		info.ForcePreConsume = true
	}
	meta := &types.TokenCountMeta{TokenType: types.TokenTypeTokenizer}
	selection := service.GetAutoPoolSelection(c)
	checkContext := selection != nil && selection.Member.ContextWindow > 0
	if info.Request != nil && (constant.CountToken || checkContext) {
		meta = info.Request.GetTokenCountMeta()
	} else {
		// Avoid building CombineText when only the pricing quantities are needed.
		switch request := info.Request.(type) {
		case *dto.GeneralOpenAIRequest:
			meta.MaxTokens = int(max(lo.FromPtr(request.MaxTokens), lo.FromPtr(request.MaxCompletionTokens)))
		case *dto.OpenAIResponsesRequest:
			meta.MaxTokens = int(lo.FromPtr(request.MaxOutputTokens))
		case *dto.ClaudeRequest:
			meta.MaxTokens = int(lo.FromPtr(request.MaxTokens))
		case *dto.ImageRequest:
			meta = request.GetTokenCountMeta()
		}
	}

	tokens, err := service.EstimateRequestToken(c, meta, info)
	if checkContext && !constant.CountToken {
		tokens, err = service.CountRequestToken(c, meta, info)
	}
	if err != nil {
		return types.NewError(err, types.ErrorCodeCountTokenFailed)
	}
	info.SetEstimatePromptTokens(tokens)
	if checkContext && (tokens > selection.Member.ContextWindow || meta.MaxTokens > selection.Member.ContextWindow-tokens) {
		return types.NewErrorWithStatusCode(errors.New(i18n.T(c, i18n.MsgRelayAutoPoolContextLimit)), types.ErrorCodeInvalidRequest, http.StatusBadRequest, types.ErrOptionWithSkipRetry())
	}

	priceData, err := helper.ModelPriceHelper(c, info, tokens, meta)
	if err != nil {
		return types.NewError(err, types.ErrorCodeModelPriceError, types.ErrOptionWithStatusCode(http.StatusBadRequest))
	}
	if selection != nil && !helper.HasModelBillingConfig(info.GetBillingModelName()) {
		return types.NewErrorWithStatusCode(errors.New(i18n.T(c, i18n.MsgRelayAutoPoolPriceRequired)), types.ErrorCodeModelPriceError, http.StatusBadRequest, types.ErrOptionWithSkipRetry())
	}
	if selected := service.GetAutoPoolSelection(c); selected != nil {
		attempts, _ := c.Get("auto_pool_billing_attempts")
		trail, _ := attempts.([]map[string]any)
		trail = append(trail, map[string]any{
			"member_id":      selected.Member.ID,
			"channel_id":     selected.Member.ChannelID,
			"actual_model":   selected.ActualModel,
			"billing_model":  info.GetBillingModelName(),
			"reserved_quota": priceData.QuotaToPreConsume,
		})
		c.Set("auto_pool_billing_attempts", trail)
	}
	if priceData.FreeModel {
		logger.LogInfo(c, common.LogText("model %s is free, skipping pre-consume", info.OriginModelName))
		return nil
	}
	return service.PreConsumeBilling(c, priceData.QuotaToPreConsume, info)
}

// RefundFailedRequestBilling applies the common final-failure policy after all
// eligible attempts have ended. A settled BillingSession never refunds again.
func RefundFailedRequestBilling(c *gin.Context, info *relaycommon.RelayInfo, apiErr *types.NewAPIError) *types.NewAPIError {
	if apiErr == nil {
		return nil
	}
	apiErr = service.NormalizeViolationFeeError(apiErr)
	if info.Billing != nil {
		info.Billing.Refund(c)
	}
	service.ChargeViolationFeeIfNeeded(c, info, apiErr)
	return apiErr
}
