package model

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

func useBootstrapAdminDB(t *testing.T, dialect string) *gorm.DB {
	t.Helper()
	var driver gorm.Dialector
	switch dialect {
	case "sqlite":
		driver = sqlite.Open(filepath.Join(t.TempDir(), "bootstrap.db") + "?_pragma=busy_timeout(5000)")
	case "mysql":
		dsn := os.Getenv("TEST_MYSQL_DSN")
		if dsn == "" {
			t.Skip("TEST_MYSQL_DSN is not configured")
		}
		driver = mysql.Open(dsn)
	case "postgres":
		dsn := os.Getenv("TEST_POSTGRES_DSN")
		if dsn == "" {
			t.Skip("TEST_POSTGRES_DSN is not configured")
		}
		driver = postgres.New(postgres.Config{DSN: dsn, PreferSimpleProtocol: true})
	}
	db, err := gorm.Open(driver, &gorm.Config{NamingStrategy: schema.NamingStrategy{TablePrefix: fmt.Sprintf("bootstrap_%d_", time.Now().UnixNano())}})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(2)
	previousDB, previousType, previousSetup := DB, common.MainDatabaseType(), constant.Setup
	DB = db
	common.SetMainDatabaseType(common.DatabaseType(dialect))
	initCol()
	t.Cleanup(func() {
		assert.NoError(t, db.Migrator().DropTable(&Setup{}, &User{}, &Option{}))
		DB = previousDB
		common.SetMainDatabaseType(previousType)
		constant.Setup = previousSetup
		initCol()
		assert.NoError(t, sqlDB.Close())
	})
	require.NoError(t, db.AutoMigrate(&User{}, &Setup{}, &Option{}))
	var version string
	query := "SELECT version()"
	if dialect == "sqlite" {
		query = "SELECT sqlite_version()"
	}
	require.NoError(t, db.Raw(query).Scan(&version).Error)
	t.Logf("database version: %s", version)
	return db
}

func TestBootstrapAdminDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := useBootstrapAdminDB(t, dialect)
			t.Setenv("INITIAL_ADMIN_USERNAME", "admin")
			t.Setenv("INITIAL_ADMIN_PASSWORD", "Bootstrap!@#123")
			t.Setenv("ACCOUNT_PASSWORD_HASH_ALGORITHM", "argon2id")
			reset := func(t *testing.T) {
				t.Helper()
				for _, record := range []any{&Setup{}, &User{}, &Option{}} {
					require.NoError(t, db.Unscoped().Session(&gorm.Session{AllowGlobalUpdate: true}).Delete(record).Error)
				}
				constant.Setup = false
			}

			t.Run("fresh_and_repeated_startup", func(t *testing.T) {
				reset(t)
				require.NoError(t, BootstrapAdminFromEnv())
				var admin User
				require.NoError(t, db.First(&admin).Error)
				assert.Equal(t, "admin", admin.Username)
				assert.Equal(t, common.RoleRootUser, admin.Role)
				assert.Equal(t, common.UserStatusEnabled, admin.Status)
				assert.Equal(t, "default", admin.Group)
				assert.Nil(t, admin.AccessToken)
				assert.NotEqual(t, os.Getenv("INITIAL_ADMIN_PASSWORD"), admin.Password)
				assert.True(t, common.ValidatePasswordAndHash(os.Getenv("INITIAL_ADMIN_PASSWORD"), admin.Password))
				assert.False(t, common.ValidatePasswordAndHash("wrong password", admin.Password))
				var setup Setup
				require.NoError(t, db.First(&setup).Error)
				assert.Equal(t, common.Version, setup.Version)
				assert.Positive(t, setup.InitializedAt)
				CheckSetup()
				assert.True(t, constant.Setup)

				// Invalid replacement credentials must neither block startup nor
				// rotate the administrator's password after initialization.
				t.Setenv("INITIAL_ADMIN_USERNAME", "")
				t.Setenv("INITIAL_ADMIN_PASSWORD", "short")
				for range 2 {
					require.NoError(t, BootstrapAdminFromEnv())
				}
				var users []User
				require.NoError(t, db.Find(&users).Error)
				require.Len(t, users, 1)
				assert.Equal(t, admin, users[0])
				var setups []Setup
				require.NoError(t, db.Find(&setups).Error)
				assert.Equal(t, []Setup{setup}, setups)
			})

			t.Run("unset_environment_preserves_web_setup", func(t *testing.T) {
				reset(t)
				for _, key := range []string{"INITIAL_ADMIN_USERNAME", "INITIAL_ADMIN_PASSWORD"} {
					t.Setenv(key, "")
					require.NoError(t, os.Unsetenv(key))
				}
				require.NoError(t, BootstrapAdminFromEnv())
				CheckSetup()
				assert.False(t, constant.Setup)
				for _, record := range []any{&User{}, &Setup{}, &Option{}} {
					var count int64
					require.NoError(t, db.Model(record).Count(&count).Error)
					assert.Zero(t, count)
				}
			})

			t.Run("invalid_configuration_creates_nothing", func(t *testing.T) {
				reset(t)
				for _, tc := range []struct {
					name, username, password   string
					omitUsername, omitPassword bool
				}{
					{name: "missing_username", password: "Bootstrap!@#123", omitUsername: true},
					{name: "missing_password", username: "admin", omitPassword: true},
					{name: "empty_values"},
					{name: "username_too_long", username: "administrator", password: "Bootstrap!@#123"},
					{name: "username_whitespace", username: " admin", password: "Bootstrap!@#123"},
					{name: "password_too_short", username: "admin", password: "short"},
					{name: "password_too_long", username: "admin", password: strings.Repeat("x", 129)},
				} {
					t.Run(tc.name, func(t *testing.T) {
						t.Setenv("INITIAL_ADMIN_USERNAME", tc.username)
						t.Setenv("INITIAL_ADMIN_PASSWORD", tc.password)
						if tc.omitUsername {
							require.NoError(t, os.Unsetenv("INITIAL_ADMIN_USERNAME"))
						}
						if tc.omitPassword {
							require.NoError(t, os.Unsetenv("INITIAL_ADMIN_PASSWORD"))
						}
						err := BootstrapAdminFromEnv()
						require.Error(t, err)
						if tc.password != "" {
							assert.NotContains(t, err.Error(), tc.password)
						}
						for _, record := range []any{&User{}, &Setup{}, &Option{}} {
							var count int64
							require.NoError(t, db.Model(record).Count(&count).Error)
							assert.Zero(t, count)
						}
					})
				}
			})

			t.Run("existing_accounts_are_never_replaced_or_promoted", func(t *testing.T) {
				for _, tc := range []struct {
					name    string
					role    int
					deleted bool
				}{
					{name: "root", role: common.RoleRootUser},
					{name: "ordinary", role: common.RoleCommonUser},
					{name: "deleted_root", role: common.RoleRootUser, deleted: true},
				} {
					t.Run(tc.name, func(t *testing.T) {
						reset(t)
						hash, err := common.HashAccountPassword("existing admin password")
						require.NoError(t, err)
						existing := User{Username: "admin", Password: hash, Role: tc.role, Status: common.UserStatusDisabled}
						require.NoError(t, db.Create(&existing).Error)
						if tc.deleted {
							require.NoError(t, db.Delete(&existing).Error)
						}
						t.Setenv("INITIAL_ADMIN_PASSWORD", "short")
						require.NoError(t, BootstrapAdminFromEnv())
						var users []User
						require.NoError(t, db.Unscoped().Find(&users).Error)
						require.Len(t, users, 1)
						assert.Equal(t, existing.Password, users[0].Password)
						assert.Equal(t, existing.Role, users[0].Role)
						assert.Equal(t, existing.Status, users[0].Status)
						assert.Equal(t, tc.deleted, users[0].DeletedAt.Valid)
					})
				}
			})

			t.Run("setup_record_prevents_reinitialization", func(t *testing.T) {
				reset(t)
				require.NoError(t, db.Create(&Setup{Version: "existing", InitializedAt: 1}).Error)
				t.Setenv("INITIAL_ADMIN_PASSWORD", "short")
				require.NoError(t, BootstrapAdminFromEnv())
				var count int64
				require.NoError(t, db.Model(&User{}).Count(&count).Error)
				assert.Zero(t, count)
			})

			t.Run("setup_failure_rolls_back_account", func(t *testing.T) {
				reset(t)
				failure := errors.New("setup storage unavailable")
				require.NoError(t, db.Callback().Create().Before("gorm:create").Register("bootstrap_setup_failure", func(tx *gorm.DB) {
					if _, ok := tx.Statement.Dest.(*Setup); ok {
						tx.AddError(failure)
					}
				}))
				err := BootstrapAdminFromEnv()
				require.NoError(t, db.Callback().Create().Remove("bootstrap_setup_failure"))
				require.ErrorIs(t, err, failure)
				for _, record := range []any{&User{}, &Setup{}, &Option{}} {
					var count int64
					require.NoError(t, db.Model(record).Count(&count).Error)
					assert.Zero(t, count)
				}
				require.NoError(t, BootstrapAdminFromEnv())
			})

			t.Run("concurrent_first_starts_create_one_admin", func(t *testing.T) {
				reset(t)
				start := make(chan struct{})
				results := make(chan error, 2)
				for range 2 {
					go func() {
						<-start
						results <- BootstrapAdminFromEnv()
					}()
				}
				close(start)
				for range 2 {
					require.NoError(t, <-results)
				}
				for _, record := range []any{&User{}, &Setup{}} {
					var count int64
					require.NoError(t, db.Model(record).Count(&count).Error)
					assert.EqualValues(t, 1, count)
				}
			})
		})
	}
}
