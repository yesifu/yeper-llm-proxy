package service

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
)

type AutoPoolRuntime struct {
	ID            string `json:"id"`
	Health        string `json:"health"`
	InFlight      int    `json:"in_flight"`
	LastChecked   int64  `json:"last_checked"`
	LastError     string `json:"last_error"`
	LatencyMS     int64  `json:"latency_ms"`
	SafeToReclaim bool   `json:"safe_to_reclaim"`
}

func autoPoolHealthKey(member AutoPoolMember) string {
	// A changed model or channel must pass a new probe, never inherit health
	// from the previous member configuration. Redis stores no upstream secrets.
	digest := sha256.Sum256([]byte(fmt.Sprintf("%s/%d/%s/%s", member.ID, member.ChannelID, member.ActualModel, member.ResourceKey)))
	return fmt.Sprintf("auto_pool:health:%x", digest)
}

func ReadAutoPoolHealth(config AutoPoolConfig, member AutoPoolMember) (AutoPoolRuntime, error) {
	result := AutoPoolRuntime{ID: member.ID, Health: "unknown"}
	if !common.RedisEnabled || common.RDB == nil {
		return result, errors.New("auto pool requires Redis")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	value, err := common.RDB.Get(ctx, autoPoolHealthKey(member)).Result()
	if errors.Is(err, redis.Nil) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	if err := common.UnmarshalJsonStr(value, &result); err != nil {
		return result, err
	}
	if time.Now().Unix()-result.LastChecked > int64(config.ProbeIntervalSeconds*3+config.ProbeTimeoutSeconds) {
		result.Health = "stale"
	}
	return result, nil
}

func RecordAutoPoolHealth(member AutoPoolMember, healthy bool, latency time.Duration) error {
	if !common.RedisEnabled || common.RDB == nil {
		return errors.New("auto pool requires Redis")
	}
	result := AutoPoolRuntime{ID: member.ID, Health: "healthy", LastChecked: time.Now().Unix(), LatencyMS: latency.Milliseconds()}
	if !healthy {
		result.Health = "unhealthy"
		result.LastError = "Auto pool upstream probe failed"
	}
	encoded, err := common.Marshal(result)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return common.RDB.Set(ctx, autoPoolHealthKey(member), encoded, 24*time.Hour).Err()
}

// Successful real traffic is also a liveness observation. Busy deployments
// need not become stale merely because probes cannot acquire a spare slot.
func RecordAutoPoolSuccess(c *gin.Context) {
	if selection := GetAutoPoolSelection(c); selection != nil {
		_ = RecordAutoPoolHealth(selection.Member, true, 0)
	}
}

func AutoPoolRuntimeSnapshot(config AutoPoolConfig) []AutoPoolRuntime {
	result := make([]AutoPoolRuntime, 0, len(config.Members))
	counts := map[string]int{}
	unsafe := map[string]bool{}
	for _, member := range config.Members {
		if member.State == "accepting" && config.Enabled {
			unsafe[member.ResourceKey] = true
		}
		if _, found := counts[member.ResourceKey]; !found {
			count, err := AutoPoolResourceInFlight(member.ResourceKey)
			if err != nil {
				count = -1
				unsafe[member.ResourceKey] = true
			}
			counts[member.ResourceKey] = count
		}
	}
	for _, member := range config.Members {
		runtime, err := ReadAutoPoolHealth(config, member)
		if err != nil {
			runtime = AutoPoolRuntime{ID: member.ID, Health: "unknown"}
		}
		runtime.InFlight = counts[member.ResourceKey]
		runtime.SafeToReclaim = !unsafe[member.ResourceKey] && runtime.InFlight == 0
		result = append(result, runtime)
	}
	return result
}

// BeginAutoPoolProbe takes the same admission lock as routing. Saving paused or
// draining therefore closes admission to background probes as well as users.
func BeginAutoPoolProbe(ctx context.Context, id string) (AutoPoolMember, *AutoPoolLease, context.Context, error) {
	autoPoolConfigMu.RLock()
	defer autoPoolConfigMu.RUnlock()
	config, err := GetAutoPoolConfig()
	if err != nil {
		return AutoPoolMember{}, nil, ctx, err
	}
	for _, member := range config.Members {
		if member.ID != id {
			continue
		}
		if !config.Enabled || member.State != "accepting" {
			return member, nil, ctx, errors.New("pool must be enabled and member accepting to probe")
		}
		lease, leaseCtx, err := AcquireAutoPoolLease(ctx, member, config.LeaseSeconds)
		return member, lease, leaseCtx, err
	}
	return AutoPoolMember{}, nil, ctx, errors.New("auto pool member was not found")
}
