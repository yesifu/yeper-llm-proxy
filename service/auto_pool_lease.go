package service

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/go-redis/redis/v8"
	"github.com/google/uuid"
)

// Redis server time avoids gateway clock skew. Expiring individual members of
// the sorted set recovers slots after process crashes; the key expiry is only
// garbage collection. Acquiring a slot and checking capacity is one operation.
var autoPoolAcquireScript = redis.NewScript(`
local now = redis.call('TIME')
local ms = now[1] * 1000 + math.floor(now[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ms)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], ms + tonumber(ARGV[2]), ARGV[3])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 2)
return 1`)

var autoPoolRenewScript = redis.NewScript(`
local now = redis.call('TIME')
local ms = now[1] * 1000 + math.floor(now[2] / 1000)
local expires = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not expires or tonumber(expires) <= ms then return 0 end
redis.call('ZADD', KEYS[1], 'XX', ms + tonumber(ARGV[2]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 2)
return 1`)

var autoPoolCountScript = redis.NewScript(`
local now = redis.call('TIME')
local ms = now[1] * 1000 + math.floor(now[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ms)
return redis.call('ZCARD', KEYS[1])`)

type AutoPoolLease struct {
	client   *redis.Client
	key      string
	id       string
	duration time.Duration
	cancel   context.CancelFunc
	stop     chan struct{}
	done     chan struct{}
	once     sync.Once
}

// AcquireAutoPoolLease counts probes and customer streams against the same
// deployment. A nil lease without error means busy. Redis failure fails closed.
func AcquireAutoPoolLease(ctx context.Context, member AutoPoolMember, seconds int) (*AutoPoolLease, context.Context, error) {
	if !common.RedisEnabled || common.RDB == nil {
		return nil, ctx, errors.New("auto pool requires Redis")
	}
	lease := &AutoPoolLease{client: common.RDB, key: "auto_pool:capacity:" + member.ResourceKey, id: uuid.NewString(), duration: time.Duration(seconds) * time.Second, stop: make(chan struct{}), done: make(chan struct{})}
	operationCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	result, err := autoPoolAcquireScript.Run(operationCtx, lease.client, []string{lease.key}, member.MaxConcurrency, lease.duration.Milliseconds(), lease.id).Int()
	cancel()
	if err != nil {
		return nil, ctx, errors.New("auto pool capacity service is unavailable")
	}
	if result == 0 {
		return nil, ctx, nil
	}
	requestCtx, requestCancel := context.WithCancel(ctx)
	lease.cancel = requestCancel
	go lease.renew(requestCtx)
	return lease, requestCtx, nil
}

func (lease *AutoPoolLease) renew(ctx context.Context) {
	defer close(lease.done)
	ticker := time.NewTicker(lease.duration / 3)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-lease.stop:
			return
		case <-ticker.C:
			operationCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			ok, err := autoPoolRenewScript.Run(operationCtx, lease.client, []string{lease.key}, lease.id, lease.duration.Milliseconds()).Int()
			cancel()
			if err != nil || ok == 0 {
				// Do not continue generating without a capacity reservation.
				lease.cancel()
				return
			}
		}
	}
}

func (lease *AutoPoolLease) Release() {
	if lease == nil {
		return
	}
	lease.once.Do(func() {
		close(lease.stop)
		lease.cancel()
		<-lease.done
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = lease.client.ZRem(ctx, lease.key, lease.id).Err()
	})
}

func AutoPoolResourceInFlight(resource string) (int, error) {
	if !common.RedisEnabled || common.RDB == nil {
		return 0, errors.New("auto pool requires Redis")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return autoPoolCountScript.Run(ctx, common.RDB, []string{"auto_pool:capacity:" + resource}).Int()
}
