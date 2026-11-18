package service

import (
	"context"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	hostdto "github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func autoPoolTestConfig() AutoPoolConfig {
	return AutoPoolConfig{Enabled: true, Model: AutoPoolModel, ProbeIntervalSeconds: 60, ProbeTimeoutSeconds: 20, LeaseSeconds: 120,
		Members: []AutoPoolMember{{ID: "node-1", ChannelID: 1, ActualModel: "model-a", Weight: 100, ResourceKey: "gpu-1", MaxConcurrency: 1, State: "accepting", SupportsTools: true}}}
}

func TestAutoPoolConfigurationAndWeights(t *testing.T) {
	config := autoPoolTestConfig()
	require.NoError(t, ValidateAutoPoolConfig(config))
	second := config.Members[0]
	second.ID = "node-2"
	second.MaxConcurrency = 2
	config.Members = append(config.Members, second)
	assert.ErrorContains(t, ValidateAutoPoolConfig(config), "same concurrency limit")
	config.Members[1].MaxConcurrency = 1
	require.NoError(t, ValidateAutoPoolConfig(config))
	config.Members[1].ID = config.Members[0].ID
	assert.ErrorContains(t, ValidateAutoPoolConfig(config), "duplicate member")
	config = autoPoolTestConfig()
	config.Members[0].Weight = -1
	assert.Error(t, ValidateAutoPoolConfig(config))
	candidates := []autoPoolCandidate{{member: AutoPoolMember{Weight: 1}}, {member: AutoPoolMember{Weight: 3}}}
	assert.Equal(t, 0, autoPoolWeightedIndex(candidates, 0))
	assert.Equal(t, 1, autoPoolWeightedIndex(candidates, 1))
	assert.Equal(t, 1, autoPoolWeightedIndex(candidates, 3))
	assert.True(t, AutoPoolChannelCompatible(&model.Channel{Type: constant.ChannelTypeVLLM}))
	assert.True(t, AutoPoolChannelCompatible(&model.Channel{Type: constant.ChannelTypeSGLang}))
	assert.False(t, AutoPoolChannelCompatible(&model.Channel{ParamOverride: common.GetPointer(`{"model":"another-model"}`)}))
}

func TestAutoPoolToolHistoryRequiresCapability(t *testing.T) {
	for _, body := range []string{
		`{"messages":[{"role":"assistant","tool_calls":[{"id":"c1","type":"function","function":{"name":"run","arguments":"{}"}}]}]}`,
		`{"messages":[{"role":"assistant","function_call":{"name":"run","arguments":"{}"}}]}`,
		`{"messages":[{"role":"tool","tool_call_id":"c1","content":"done"}]}`,
		`{"messages":[{"role":"function","name":"run","content":"done"}]}`,
		`{"input":[{"type":"function_call","call_id":"c1","name":"run","arguments":"{}"}]}`,
		`{"input":[{"type":"function_call_output","call_id":"c1","output":"done"}]}`,
	} {
		assert.True(t, autoPoolNeedsTools([]byte(body)), body)
	}
	assert.False(t, autoPoolNeedsTools([]byte(`{"messages":[{"role":"user","content":"Explain function_call_output"}]}`)))
}

func TestAutoPoolRejectsUnsupportedMedia(t *testing.T) {
	for _, body := range []string{
		`{"modalities":["text","audio"]}`,
		`{"audio":{"voice":"alloy","format":"wav"}}`,
		`{"messages":[{"role":"user","content":[{"type":"input_audio","input_audio":{"data":"...","format":"wav"}}]}]}`,
		`{"messages":[{"role":"assistant","audio":{"id":"previous-audio"}}]}`,
		`{"input":[{"type":"message","content":[{"type":"input_file","file_id":"f1"}]}]}`,
		`{"input":[{"type":"input_audio","data":"..."}]}`,
	} {
		assert.True(t, autoPoolUnsupportedMedia([]byte(body)), body)
	}
	assert.False(t, autoPoolUnsupportedMedia([]byte(`{"input":[{"role":"user","content":[{"type":"input_text","text":"transcribe audio"},{"type":"input_image","image_url":"data:image/png;base64,..."}]}]}`)))
}

func autoPoolTestRedis(t *testing.T) *redis.Client {
	t.Helper()
	url := os.Getenv("AUTO_POOL_TEST_REDIS")
	if url == "" {
		t.Skip("set AUTO_POOL_TEST_REDIS to run capacity and routing checks against a real Redis")
	}
	options, err := redis.ParseURL(url)
	require.NoError(t, err)
	client := redis.NewClient(options)
	require.NoError(t, client.Ping(context.Background()).Err())
	oldClient, oldEnabled := common.RDB, common.RedisEnabled
	common.RDB, common.RedisEnabled = client, true
	t.Cleanup(func() { common.RDB, common.RedisEnabled = oldClient, oldEnabled; require.NoError(t, client.Close()) })
	return client
}

func TestAutoPoolSharedCapacityAndCrashRecovery(t *testing.T) {
	client := autoPoolTestRedis(t)
	member := autoPoolTestConfig().Members[0]
	member.ResourceKey = "test-" + uuid.NewString()
	ctx := context.Background()
	first, firstCtx, err := AcquireAutoPoolLease(ctx, member, 120)
	require.NoError(t, err)
	require.NotNil(t, first)
	t.Cleanup(first.Release)
	alias := member
	alias.ID = "different-member"
	alias.ChannelID = 999
	blocked, _, err := AcquireAutoPoolLease(ctx, alias, 120)
	require.NoError(t, err)
	assert.Nil(t, blocked, "aliases for one deployment share capacity")
	count, err := AutoPoolResourceInFlight(member.ResourceKey)
	require.NoError(t, err)
	assert.Equal(t, 1, count)

	// A crashed owner's expired score is pruned atomically on next admission.
	require.NoError(t, client.ZAdd(ctx, first.key, &redis.Z{Score: 0, Member: first.id}).Err())
	replacement, _, err := AcquireAutoPoolLease(ctx, alias, 120)
	require.NoError(t, err)
	require.NotNil(t, replacement)
	t.Cleanup(replacement.Release)
	renewed, err := autoPoolRenewScript.Run(ctx, client, []string{first.key}, first.id, 120000).Int()
	require.NoError(t, err)
	assert.Zero(t, renewed, "an expired owner cannot resurrect its slot")
	first.Release()
	first.Release()
	assert.ErrorIs(t, firstCtx.Err(), context.Canceled)
	count, err = AutoPoolResourceInFlight(member.ResourceKey)
	require.NoError(t, err)
	assert.Equal(t, 1, count, "release removes only its own lease")
	replacement.Release()
	count, err = AutoPoolResourceInFlight(member.ResourceKey)
	require.NoError(t, err)
	assert.Zero(t, count)
}

func TestAutoPoolRoutingHealthDrainAndPermissions(t *testing.T) {
	client := autoPoolTestRedis(t)
	db := setupChannelSelectAutoGroupsTest(t)
	createChannelSelectAutoGroupsChannel(t, db, 1, "default", "model-a")
	createChannelSelectAutoGroupsChannel(t, db, 2, "vip", "model-b")
	model.InitChannelCache()
	config := autoPoolTestConfig()
	config.Members[0].ResourceKey = "test-" + uuid.NewString()
	second := config.Members[0]
	second.ID = "node-2"
	second.ChannelID = 2
	second.ActualModel = "model-b"
	second.ResourceKey = "test-" + uuid.NewString()
	config.Members = append(config.Members, second)
	common.OptionMapRWMutex.Lock()
	original := common.OptionMap[AutoPoolOptionKey]
	if common.OptionMap == nil {
		common.OptionMap = make(map[string]string)
	}
	common.OptionMapRWMutex.Unlock()
	t.Cleanup(func() {
		common.OptionMapRWMutex.Lock()
		common.OptionMap[AutoPoolOptionKey] = original
		common.OptionMapRWMutex.Unlock()
		for _, member := range config.Members {
			_ = client.Del(context.Background(), autoPoolHealthKey(member), "auto_pool:capacity:"+member.ResourceKey).Err()
		}
	})
	save := func() {
		encoded, err := common.Marshal(config)
		require.NoError(t, err)
		common.OptionMapRWMutex.Lock()
		common.OptionMap[AutoPoolOptionKey] = string(encoded)
		common.OptionMapRWMutex.Unlock()
	}
	request := func(body string) *gin.Context {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
		c.Request.Header.Set("Content-Type", "application/json")
		common.SetContextKey(c, constant.ContextKeyUserGroup, "default")
		t.Cleanup(func() { ReleaseAutoPoolLease(c); common.CleanupBodyStorage(c) })
		return c
	}
	body := `{"model":"llm-auto","messages":[{"role":"user","content":"hello"}],"max_tokens":8}`
	save()
	c := request(body)
	channel, group, err := SelectAutoPoolChannel(c, AutoPoolModel, "default")
	require.NoError(t, err)
	assert.Equal(t, 1, channel.Id)
	assert.Equal(t, "default", group)
	_, _, err = SelectAutoPoolChannel(c, AutoPoolModel, "default")
	assert.Error(t, err, "retry excludes attempted member, and vip channel must not bypass group restrictions")
	assert.NoError(t, c.Request.Context().Err(), "releasing an attempt must not cancel retry's base context")
	ReleaseAutoPoolLease(c)

	c = request(body)
	GetChannelConstraints(c).AddPin(hostdto.ChannelPin{ChannelId: 2, Source: hostdto.PinSourceToken})
	_, _, err = SelectAutoPoolChannel(c, AutoPoolModel, "default")
	assert.Error(t, err, "pin does not bypass group access")

	config.Members[0].State = "draining"
	save()
	_, _, err = SelectAutoPoolChannel(request(body), AutoPoolModel, "default")
	assert.Error(t, err)
	_, lease, _, err := BeginAutoPoolProbe(context.Background(), config.Members[0].ID)
	assert.Error(t, err)
	assert.Nil(t, lease, "drain stops probes as well as customer requests")
	require.NoError(t, RecordAutoPoolHealth(config.Members[0], true, time.Millisecond))
	_, _, err = SelectAutoPoolChannel(request(body), AutoPoolModel, "default")
	assert.Error(t, err, "healthy probe must not reopen a drained member")

	config.Members[0].State = "accepting"
	config.HealthEnabled = true
	save()
	_, _, err = SelectAutoPoolChannel(request(body), AutoPoolModel, "vip")
	assert.Error(t, err, "unknown health is excluded")
	c = request(body)
	channel, _, err = SelectAutoPoolChannel(c, AutoPoolModel, "default")
	require.NoError(t, err)
	assert.Equal(t, 1, channel.Id)
	ReleaseAutoPoolLease(c)

	config.Members[0].SupportsTools = false
	save()
	_, _, err = SelectAutoPoolChannel(request(`{"model":"llm-auto","messages":[],"tools":[{"type":"function","function":{"name":"run"}}]}`), AutoPoolModel, "default")
	assert.Error(t, err, "tool requests cannot route to members without tools")
	config.Members[0].ContextWindow = 4
	save()
	_, _, err = SelectAutoPoolChannel(request(body), AutoPoolModel, "default")
	assert.Error(t, err, "output limit alone already exceeds context window")

	config.Members[0].State = "draining"
	config.Members[1].ResourceKey = config.Members[0].ResourceKey
	save()
	runtime := AutoPoolRuntimeSnapshot(config)
	assert.False(t, runtime[0].SafeToReclaim, "another accepting alias can still admit work on the shared resource")
	config.Members[1].State = "paused"
	save()
	runtime = AutoPoolRuntimeSnapshot(config)
	assert.True(t, runtime[0].SafeToReclaim)
	common.RedisEnabled = false
	runtime = AutoPoolRuntimeSnapshot(config)
	assert.False(t, runtime[0].SafeToReclaim, "unobservable capacity is never safe to reclaim")
}
