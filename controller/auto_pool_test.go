package controller

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/service/authz"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestAutoPoolHealthWorkerBoundsConcurrencyAndDoesNotOverlapTicks(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ticks := make(chan time.Time, 1)
	started := make(chan string, 32)
	reloaded := make(chan struct{}, 4)
	violations := make(chan string, 32)
	done := make(chan struct{})
	var active atomic.Int32
	var running sync.Map
	config := service.AutoPoolConfig{Enabled: true, HealthEnabled: true, ProbeIntervalSeconds: 60}
	gates := map[string]chan struct{}{}
	for i := range 20 {
		id := fmt.Sprintf("node-%02d", i)
		config.Members = append(config.Members, service.AutoPoolMember{ID: id, State: "accepting"})
		gates[id] = make(chan struct{})
	}
	go func() {
		defer close(done)
		runAutoPoolHealthWorker(ctx, ticks, func() (service.AutoPoolConfig, error) {
			reloaded <- struct{}{}
			return config, nil
		}, func(ctx context.Context, id string) bool {
			if _, duplicate := running.LoadOrStore(id, true); duplicate {
				violations <- "overlapping probe for " + id
			}
			defer running.Delete(id)
			if active.Add(1) > 16 {
				violations <- "more than 16 upstream probes"
			}
			defer active.Add(-1)
			started <- id
			select {
			case <-gates[id]:
			case <-ctx.Done():
			}
			return true
		})
	}()
	observed := map[string]bool{}
	for range 16 {
		select {
		case id := <-started:
			require.False(t, observed[id], "initial probe must be unique")
			observed[id] = true
		case <-ctx.Done():
			require.FailNow(t, "independent upstream probes should start concurrently")
		}
	}
	<-reloaded
	ticks <- time.Now()
	select {
	case <-reloaded:
	case <-ctx.Done():
		require.FailNow(t, "scheduler must process ticks while probes are blocked")
	}
	// One completed probe immediately admits the next waiting member; the
	// other slow upstreams do not force it to wait for a whole batch or tick.
	close(gates["node-00"])
	select {
	case id := <-started:
		assert.False(t, observed[id], "a later member must run before an already attempted member")
	case <-ctx.Done():
		require.FailNow(t, "completed work must free a slot for waiting members")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		require.FailNow(t, "cancellation must stop the scheduler and all workers")
	}
	assert.Zero(t, active.Load())
	assert.Empty(t, violations)
}

func TestAutoPoolPersistenceDatabaseMatrix(t *testing.T) {
	for _, dialect := range []struct{ kind, env string }{{"sqlite", ""}, {"mysql", "TEST_MYSQL_DSN"}, {"postgres", "TEST_POSTGRES_DSN"}} {
		t.Run(dialect.kind, func(t *testing.T) {
			if dialect.env != "" && os.Getenv(dialect.env) == "" {
				t.Skip("set " + dialect.env + " to run this database")
			}
			db := modelManagementDB(t, dialect.kind, os.Getenv(dialect.env))
			require.NoError(t, db.AutoMigrate(&model.SystemTask{}))
			channel := model.Channel{Type: constant.ChannelTypeOpenAI, Name: "pool-test", Key: "upstream-secret-must-not-be-returned", Status: common.ChannelStatusEnabled, Models: "model-a", Group: "default"}
			require.NoError(t, db.Create(&channel).Error)
			// Start with an ordinary pre-existing option, as an upgrade would.
			require.NoError(t, model.UpdateOptionsBulk(map[string]string{"AutoPoolTestUnrelated": "preserve-me"}))
			config, err := service.GetAutoPoolConfig()
			require.NoError(t, err)
			assert.False(t, config.Enabled)
			assert.Empty(t, config.Members)
			config.Enabled = true
			config.Members = []service.AutoPoolMember{{ID: "test-node", ChannelID: channel.Id, ActualModel: "model-a", Weight: 25, ResourceKey: "test-resource", MaxConcurrency: 3, State: "paused", SupportsTools: true}}
			var response struct {
				Success bool `json:"success"`
				Data    struct {
					Config  service.AutoPoolConfig    `json:"config"`
					Runtime []service.AutoPoolRuntime `json:"runtime"`
				} `json:"data"`
			}
			recorder := modelManagementRequest(t, UpdateAutoPool, http.MethodPut, "/api/auto_pool/", config, &response)
			require.True(t, response.Success, recorder.Body.String())
			assert.Equal(t, config, response.Data.Config)
			assert.NotContains(t, recorder.Body.String(), channel.Key)
			var stored model.Option
			require.NoError(t, db.Where(map[string]any{"key": service.AutoPoolOptionKey}).First(&stored).Error)
			var persisted service.AutoPoolConfig
			require.NoError(t, common.UnmarshalJsonStr(stored.Value, &persisted))
			assert.Equal(t, config, persisted)
			for range 2 {
				common.OptionMapRWMutex.Lock()
				delete(common.OptionMap, service.AutoPoolOptionKey)
				delete(common.OptionMap, "AutoPoolTestUnrelated")
				common.OptionMapRWMutex.Unlock()
				require.NoError(t, model.LoadOptionsFromDatabase())
				restored, err := service.GetAutoPoolConfig()
				require.NoError(t, err)
				assert.Equal(t, config, restored)
				common.OptionMapRWMutex.RLock()
				assert.Equal(t, "preserve-me", common.OptionMap["AutoPoolTestUnrelated"])
				common.OptionMapRWMutex.RUnlock()
			}
			var count int64
			require.NoError(t, db.Model(&model.Option{}).Where(map[string]any{"key": service.AutoPoolOptionKey}).Count(&count).Error)
			assert.EqualValues(t, 1, count, "repeated reload does not duplicate the config")

			// Inject a storage write failure into the real transaction, after
			// validation and channel reads. It must not publish a phantom config.
			writeFailure := errors.New("injected auto pool storage write failure")
			require.NoError(t, db.Callback().Update().Before("gorm:update").Register("auto_pool_test_write_failure", func(tx *gorm.DB) {
				if tx.Statement.Table == "options" {
					tx.AddError(writeFailure)
				}
			}))
			changed := config
			changed.Members = append([]service.AutoPoolMember(nil), config.Members...)
			changed.Members[0].Weight = 75
			assert.ErrorIs(t, service.SaveAutoPoolConfig(changed), writeFailure)
			require.NoError(t, db.Callback().Update().Remove("auto_pool_test_write_failure"))
			current, err := service.GetAutoPoolConfig()
			require.NoError(t, err)
			assert.Equal(t, config, current)
			require.NoError(t, db.Where(map[string]any{"key": service.AutoPoolOptionKey}).First(&stored).Error)
			require.NoError(t, common.UnmarshalJsonStr(stored.Value, &persisted))
			assert.Equal(t, config, persisted)
			require.NoError(t, service.SaveAutoPoolConfig(changed))
			require.NoError(t, model.LoadOptionsFromDatabase())
			current, err = service.GetAutoPoolConfig()
			require.NoError(t, err)
			assert.Equal(t, 75, current.Members[0].Weight)
		})
	}
}

func TestAutoPoolManagementAuthorization(t *testing.T) {
	admin, _ := setupAccessTokenAudit(t)
	require.NoError(t, model.DB.AutoMigrate(&model.SystemTask{}))
	previousOptions := common.OptionMap
	previousMemory := common.MemoryCacheEnabled
	common.OptionMap = map[string]string{}
	common.MemoryCacheEnabled = false
	t.Cleanup(func() { common.OptionMap = previousOptions; common.MemoryCacheEnabled = previousMemory })
	regular := model.User{Username: "pool-client", Password: "placeholder", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1, AffCode: "pool-client"}
	require.NoError(t, model.DB.Create(&regular).Error)
	_, regularSession := createAccessTokenTestSession(t, regular.Id, "pool-client-session")
	_, adminSession := createAccessTokenTestSession(t, admin.Id, "pool-admin-session")
	readToken, _ := createScopedAccessToken(t, admin.Id, time.Now().Unix()+3600, service.AccessTokenScopeOf(authz.ChannelRead))
	writeToken, _ := createScopedAccessToken(t, admin.Id, time.Now().Unix()+3600, service.AccessTokenScopeOf(authz.ChannelWrite))
	operateToken, _ := createScopedAccessToken(t, admin.Id, time.Now().Unix()+3600, service.AccessTokenScopeOf(authz.ChannelOperate))
	router := gin.New()
	router.Use(middleware.RequestId())
	// Mirror the real registration, including PAT scopes and Casbin checks;
	// importing router here would create a controller/router import cycle.
	for _, route := range []struct {
		method, path string
		permission   authz.Permission
		handler      gin.HandlerFunc
	}{
		{http.MethodGet, "/api/auto_pool/", authz.ChannelRead, GetAutoPool},
		{http.MethodPut, "/api/auto_pool/", authz.ChannelWrite, UpdateAutoPool},
		{http.MethodPost, "/api/auto_pool/probe/:id", authz.ChannelOperate, ProbeAutoPoolMember},
	} {
		middleware.DeclareAccessTokenPermissionRoute(route.method, route.path, route.permission)
		router.Handle(route.method, route.path, middleware.AdminAuth(), middleware.RequirePermission(route.permission), route.handler)
	}
	config, err := service.GetAutoPoolConfig()
	require.NoError(t, err)
	body, err := common.Marshal(config)
	require.NoError(t, err)
	request := func(method, path, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	for _, tc := range []struct {
		name, token string
		status      int
	}{{"anonymous", "", http.StatusUnauthorized}, {"invalid", "not-a-valid-token", http.StatusUnauthorized}, {"ordinary user", regularSession, http.StatusForbidden}} {
		for _, route := range []struct{ method, path string }{{http.MethodGet, "/api/auto_pool/"}, {http.MethodPut, "/api/auto_pool/"}, {http.MethodPost, "/api/auto_pool/probe/missing"}} {
			response := request(route.method, route.path, tc.token)
			assert.Equal(t, tc.status, response.Code, tc.name+" "+route.method+": "+response.Body.String())
		}
	}
	assert.Equal(t, http.StatusOK, request(http.MethodGet, "/api/auto_pool/", readToken).Code)
	assert.Equal(t, http.StatusForbidden, request(http.MethodPut, "/api/auto_pool/", readToken).Code)
	assert.Equal(t, http.StatusForbidden, request(http.MethodPost, "/api/auto_pool/probe/missing", readToken).Code)
	response := request(http.MethodPut, "/api/auto_pool/", writeToken)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), `"success":true`)
	response = request(http.MethodPost, "/api/auto_pool/probe/missing", operateToken)
	require.Equal(t, http.StatusOK, response.Code)
	assert.Contains(t, response.Body.String(), "Auto pool member was not found", "operate scope reaches handler")

	// A correct scope cannot override an administrator's explicitly revoked
	// permission; the browser session observes the same server-side decision.
	require.NoError(t, authz.SetUserPermissions(admin.Id, authz.PermissionsMap{authz.ResourceChannel: {authz.ActionRead: true, authz.ActionWrite: false, authz.ActionOperate: false}}))
	for _, token := range []string{writeToken, operateToken, adminSession} {
		assert.Equal(t, http.StatusForbidden, request(http.MethodPut, "/api/auto_pool/", token).Code)
		assert.Equal(t, http.StatusForbidden, request(http.MethodPost, "/api/auto_pool/probe/missing", token).Code)
	}
}
