package controller

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/config"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

type autoPoolRelayFixture struct {
	db     *gorm.DB
	user   model.User
	token  model.Token
	pool   service.AutoPoolConfig
	engine *gin.Engine
}

func newAutoPoolRelayFixture(t *testing.T, handler http.HandlerFunc) *autoPoolRelayFixture {
	t.Helper()
	redisURL := os.Getenv("AUTO_POOL_TEST_REDIS")
	if redisURL == "" {
		t.Skip("AUTO_POOL_TEST_REDIS must name a dedicated local test Redis database")
	}
	options, err := redis.ParseURL(redisURL)
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(options.Addr, "127.0.0.1:"), "only a local test Redis is allowed")
	require.Positive(t, options.DB, "use an isolated non-default Redis database")
	f := &autoPoolRelayFixture{db: modelManagementDB(t, "sqlite", "")}
	require.NoError(t, f.db.AutoMigrate(&model.Token{}, &model.Log{}, &model.SystemTask{}))
	previousRDB := common.RDB
	common.RDB = redis.NewClient(options)
	require.NoError(t, common.RDB.Ping(context.Background()).Err())
	client := common.RDB
	common.RedisEnabled = true
	previousCount, previousLog, previousBatch, previousRetry := constant.CountToken, common.LogConsumeEnabled, common.BatchUpdateEnabled, common.RetryTimes
	constant.CountToken, common.LogConsumeEnabled, common.BatchUpdateEnabled, common.RetryTimes = false, true, false, 1
	previousQuota := common.QuotaPerUnit
	previousStreamTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 10
	common.QuotaPerUnit = 500000
	resource := "relay-test-" + uuid.NewString()
	t.Cleanup(func() {
		_ = client.Del(context.Background(), "auto_pool:capacity:"+resource).Err()
		require.NoError(t, client.Close())
		common.RDB = previousRDB
		constant.CountToken, common.LogConsumeEnabled, common.BatchUpdateEnabled, common.RetryTimes = previousCount, previousLog, previousBatch, previousRetry
		common.QuotaPerUnit = previousQuota
		constant.StreamingTimeout = previousStreamTimeout
	})
	require.NoError(t, i18n.Init())
	service.InitHttpClient()
	key := strings.ReplaceAll(uuid.NewString(), "-", "")
	f.user = model.User{Id: int(time.Now().UnixNano()%1000000000) + 1, Username: "pool-" + key, Role: common.RoleCommonUser, Status: common.UserStatusEnabled, Group: "default", Quota: 100000,
		Setting: `{"billing_preference":"wallet_only"}`}
	require.NoError(t, f.db.Create(&f.user).Error)
	f.token = model.Token{UserId: f.user.Id, Key: key, Status: common.TokenStatusEnabled, Name: "pool-test", RemainQuota: 100000, ExpiredTime: -1, ModelLimitsEnabled: true, ModelLimits: "llm-auto"}
	require.NoError(t, f.db.Create(&f.token).Error)
	upstream := httptest.NewServer(handler)
	t.Cleanup(upstream.Close)
	for id, actual := range []string{"pool-model-a", "pool-model-b"} {
		channel := model.Channel{Id: id + 1, Name: actual, Type: constant.ChannelTypeOpenAI, Key: "test-upstream-key", BaseURL: &upstream.URL,
			Status: common.ChannelStatusEnabled, Models: actual, Group: "default", AutoBan: common.GetPointer(0)}
		require.NoError(t, f.db.Create(&channel).Error)
		require.NoError(t, channel.AddAbilities(f.db))
	}
	f.pool = service.AutoPoolConfig{Enabled: true, Model: "llm-auto", HealthEnabled: false, ProbeIntervalSeconds: 60, ProbeTimeoutSeconds: 20, LeaseSeconds: 120,
		Members: []service.AutoPoolMember{
			{ID: "first", ChannelID: 1, ActualModel: "pool-model-a", Weight: 100, ResourceKey: resource, MaxConcurrency: 1, State: "accepting", SupportsTools: true},
			{ID: "second", ChannelID: 2, ActualModel: "pool-model-b", Weight: 0, ResourceKey: resource, MaxConcurrency: 1, State: "accepting", SupportsTools: true},
		}}
	require.NoError(t, service.SaveAutoPoolConfig(f.pool))
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1}`))
	config.UpdateConfigFromMap(config.GlobalConfig.Get("billing_setting"), map[string]string{
		"billing_mode": `{"pool-model-a":"tiered_expr","pool-model-b":"tiered_expr","llm-auto":"tiered_expr"}`,
		"billing_expr": `{"pool-model-a":"tier(\"request\", fixed(0.001))","pool-model-b":"tier(\"request\", fixed(0.003))","llm-auto":"tier(\"request\", fixed(0.9))"}`,
	})
	f.engine = gin.New()
	f.engine.Use(middleware.RequestId(), middleware.TokenAuth())
	f.engine.POST("/v1/chat/completions", middleware.Distribute(), func(c *gin.Context) { Relay(c, types.RelayFormatOpenAI) })
	f.engine.GET("/v1/models", func(c *gin.Context) { ListModels(c, constant.ChannelTypeOpenAI) })
	return f
}

func (f *autoPoolRelayFixture) request(t *testing.T, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	method := http.MethodPost
	if body == "" {
		method = http.MethodGet
	}
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer sk-"+f.token.Key)
	w := httptest.NewRecorder()
	f.engine.ServeHTTP(w, r)
	return w
}

func TestAutoPoolRelayRetryChargesSelectedModelOnce(t *testing.T) {
	var f *autoPoolRelayFixture
	var attempts atomic.Int32
	f = newAutoPoolRelayFixture(t, func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Model string `json:"model"`
		}
		if !assert.NoError(t, common.DecodeJson(r.Body, &request)) {
			w.WriteHeader(500)
			return
		}
		assert.Equal(t, "Bearer test-upstream-key", r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		if attempts.Add(1) == 1 {
			assert.Equal(t, "pool-model-a", request.Model)
			f.pool.Members[0].Weight, f.pool.Members[1].Weight = 0, 100
			if !assert.NoError(t, service.SaveAutoPoolConfig(f.pool)) {
				w.WriteHeader(500)
				return
			}
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = io.WriteString(w, `{"error":{"message":"temporary outage","type":"server_error"}}`)
			return
		}
		assert.Equal(t, "pool-model-b", request.Model)
		var user model.User
		assert.NoError(t, f.db.First(&user, f.user.Id).Error)
		assert.Equal(t, 98500, user.Quota, "the more expensive retry is reserved before upstream submission")
		// An admin changes pricing during generation. The response must still
		// settle against the second attempt's already captured price.
		config.UpdateConfigFromMap(config.GlobalConfig.Get("billing_setting"), map[string]string{
			"billing_expr": `{"pool-model-b":"tier(\"request\", fixed(0.009))"}`,
		})
		_, _ = io.WriteString(w, `{"id":"chatcmpl-test","object":"chat.completion","model":"pool-model-b","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`)
	})
	models := f.request(t, "/v1/models", "")
	require.Equal(t, http.StatusOK, models.Code, models.Body.String())
	assert.Contains(t, models.Body.String(), `"id":"llm-auto"`)
	w := f.request(t, "/v1/chat/completions", `{"model":"llm-auto","messages":[{"role":"user","content":"hello"}]}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, int32(2), attempts.Load())
	assert.Equal(t, "pool-model-b", w.Header().Get("X-LLM-Model"))
	var user model.User
	require.NoError(t, f.db.First(&user, f.user.Id).Error)
	assert.Equal(t, 98500, user.Quota)
	var token model.Token
	require.NoError(t, f.db.First(&token, f.token.Id).Error)
	assert.Equal(t, 98500, token.RemainQuota)
	var logs []model.Log
	require.NoError(t, f.db.Where("user_id = ? AND type = ?", f.user.Id, model.LogTypeConsume).Find(&logs).Error)
	require.Len(t, logs, 1, "failed attempts must not create a second customer charge")
	assert.Equal(t, "pool-model-b", logs[0].ModelName)
	assert.Equal(t, 1500, logs[0].Quota)
	assert.Contains(t, logs[0].Other, `"requested_model":"llm-auto"`)
	assert.Contains(t, logs[0].Other, `"auto_pool_attempts"`)
	count, err := service.AutoPoolResourceInFlight(f.pool.Members[0].ResourceKey)
	require.NoError(t, err)
	assert.Zero(t, count)
	denied := f.request(t, "/v1/chat/completions", `{"model":"pool-model-a","messages":[{"role":"user","content":"hello"}]}`)
	assert.Equal(t, http.StatusForbidden, denied.Code, "an auto-only key cannot bypass the pool")
}

func TestAutoPoolRelayStreamingHoldsCapacityAndDrains(t *testing.T) {
	release := make(chan struct{})
	var closeOnce sync.Once
	t.Cleanup(func() { closeOnce.Do(func() { close(release) }) })
	f := newAutoPoolRelayFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"id\":\"stream-test\",\"object\":\"chat.completion.chunk\",\"model\":\"pool-model-a\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_test\",\"type\":\"function\",\"function\":{\"name\":\"ping\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n")
		_, _ = io.WriteString(w, "data: {\"id\":\"stream-test\",\"object\":\"chat.completion.chunk\",\"model\":\"pool-model-a\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":null}]}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, "data: {\"id\":\"stream-test\",\"object\":\"chat.completion.chunk\",\"model\":\"pool-model-a\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15}}\n\ndata: [DONE]\n\n")
	})
	gateway := httptest.NewServer(f.engine)
	t.Cleanup(gateway.Close)
	r, err := http.NewRequest(http.MethodPost, gateway.URL+"/v1/chat/completions", strings.NewReader(`{"model":"llm-auto","stream":true,"messages":[{"role":"user","content":"call ping"}],"tools":[{"type":"function","function":{"name":"ping","parameters":{"type":"object","properties":{}}}}]}`))
	require.NoError(t, err)
	r.Header.Set("Authorization", "Bearer sk-"+f.token.Key)
	r.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second}
	response, err := client.Do(r)
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, http.StatusOK, response.StatusCode)
	reader := bufio.NewReader(response.Body)
	first, err := reader.ReadString('\n')
	require.NoError(t, err)
	assert.Contains(t, first, "tool_calls")
	count, err := service.AutoPoolResourceInFlight(f.pool.Members[0].ResourceKey)
	require.NoError(t, err)
	assert.Equal(t, 1, count)
	busy := f.request(t, "/v1/chat/completions", `{"model":"llm-auto","messages":[{"role":"user","content":"another"}]}`)
	assert.Equal(t, http.StatusServiceUnavailable, busy.Code)
	for i := range f.pool.Members {
		f.pool.Members[i].State = "draining"
	}
	require.NoError(t, service.SaveAutoPoolConfig(f.pool))
	assert.False(t, service.AutoPoolRuntimeSnapshot(f.pool)[0].SafeToReclaim)
	closeOnce.Do(func() { close(release) })
	tail, err := io.ReadAll(reader)
	require.NoError(t, err)
	assert.Contains(t, string(tail), "[DONE]")
	// The request middleware releases after the handler's settlement, so
	// synchronize through the observed lease count, not an arbitrary sleep.
	require.Eventually(t, func() bool {
		n, e := service.AutoPoolResourceInFlight(f.pool.Members[0].ResourceKey)
		return e == nil && n == 0
	}, 2*time.Second, 10*time.Millisecond)
	assert.True(t, service.AutoPoolRuntimeSnapshot(f.pool)[0].SafeToReclaim)
	paused := f.request(t, "/v1/chat/completions", `{"model":"llm-auto","messages":[{"role":"user","content":"another"}]}`)
	assert.Equal(t, http.StatusServiceUnavailable, paused.Code)
	var logs []model.Log
	require.NoError(t, f.db.Where("user_id = ? AND type = ?", f.user.Id, model.LogTypeConsume).Find(&logs).Error)
	require.Len(t, logs, 1)
	assert.Equal(t, 500, logs[0].Quota, fmt.Sprint(logs))
}

func TestAutoPoolRelayTokenPriceUsesActualModel(t *testing.T) {
	for _, channelType := range []int{constant.ChannelTypeOpenAI, constant.ChannelTypeVLLM, constant.ChannelTypeSGLang} {
		t.Run(constant.GetChannelTypeName(channelType), func(t *testing.T) {
			f := newAutoPoolRelayFixture(t, func(w http.ResponseWriter, r *http.Request) {
				var request struct {
					Model string `json:"model"`
				}
				assert.NoError(t, common.DecodeJson(r.Body, &request))
				assert.Equal(t, "pool-model-a", request.Model)
				assert.Equal(t, "/v1/chat/completions", r.URL.Path)
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"id":"chatcmpl-test","object":"chat.completion","model":"pool-model-a","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`)
			})
			require.NoError(t, f.db.Model(&model.Channel{}).Where("id = ?", 1).Update("type", channelType).Error)
			config.UpdateConfigFromMap(config.GlobalConfig.Get("billing_setting"), map[string]string{"billing_mode": "{}", "billing_expr": "{}"})
			require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"pool-model-a":2,"llm-auto":999}`))
			require.NoError(t, ratio_setting.UpdateCompletionRatioByJSONString(`{"pool-model-a":3,"llm-auto":999}`))
			w := f.request(t, "/v1/chat/completions", `{"model":"llm-auto","messages":[{"role":"user","content":"hello"}]}`)
			require.Equal(t, http.StatusOK, w.Code, w.Body.String())
			var logs []model.Log
			require.NoError(t, f.db.Where("user_id = ? AND type = ?", f.user.Id, model.LogTypeConsume).Find(&logs).Error)
			require.Len(t, logs, 1)
			assert.Equal(t, 50, logs[0].Quota, "2 * (10 input + 5 output * 3)")
			assert.Equal(t, "pool-model-a", logs[0].ModelName)
		})
	}
}

func TestAutoPoolRelayExpensiveRetryCannotOverdrawAndRefunds(t *testing.T) {
	var f *autoPoolRelayFixture
	var attempts atomic.Int32
	f = newAutoPoolRelayFixture(t, func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		f.pool.Members[0].Weight, f.pool.Members[1].Weight = 0, 100
		assert.NoError(t, service.SaveAutoPoolConfig(f.pool))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"error":{"message":"temporary outage","type":"server_error"}}`)
	})
	require.NoError(t, f.db.Model(&model.User{}).Where("id = ?", f.user.Id).Update("quota", 1000).Error)
	w := f.request(t, "/v1/chat/completions", `{"model":"llm-auto","messages":[{"role":"user","content":"hello"}]}`)
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	assert.Equal(t, int32(1), attempts.Load(), "unaffordable retry must not reach upstream")
	require.Eventually(t, func() bool {
		var user model.User
		return f.db.First(&user, f.user.Id).Error == nil && user.Quota == 1000
	}, 2*time.Second, 10*time.Millisecond)
	var count int64
	require.NoError(t, f.db.Model(&model.Log{}).Where("user_id = ? AND type = ?", f.user.Id, model.LogTypeConsume).Count(&count).Error)
	assert.Zero(t, count)
	inFlight, err := service.AutoPoolResourceInFlight(f.pool.Members[0].ResourceKey)
	require.NoError(t, err)
	assert.Zero(t, inFlight)
}
