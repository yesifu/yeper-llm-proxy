package model

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// BootstrapAdminFromEnv optionally completes first-install setup before the HTTP
// server starts. Environment changes never modify an existing installation.
func BootstrapAdminFromEnv() error {
	username, usernameSet := os.LookupEnv("INITIAL_ADMIN_USERNAME")
	password, passwordSet := os.LookupEnv("INITIAL_ADMIN_PASSWORD")
	if !usernameSet && !passwordSet {
		return nil
	}
	initialized, err := adminBootstrapAlreadyInitialized(DB)
	if err != nil || initialized {
		return err
	}

	return DB.Transaction(func(tx *gorm.DB) error {
		// The shared option row serializes simultaneous first starts. In SQLite,
		// this first write acquires the database's writer lock instead.
		guard := Option{Key: "InitialAdminBootstrap", Value: "1"}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&guard).Error; err != nil {
			return fmt.Errorf("lock initial administrator setup: %w", err)
		}
		if err := lockForUpdate(tx).Where(&Option{Key: guard.Key}).Take(&guard).Error; err != nil {
			return fmt.Errorf("lock initial administrator setup: %w", err)
		}
		initialized, err := adminBootstrapAlreadyInitialized(tx)
		if err != nil || initialized {
			return err
		}
		if !usernameSet || !utf8.ValidString(username) || strings.TrimSpace(username) == "" || strings.TrimSpace(username) != username || len(username) > 12 {
			return errors.New("INITIAL_ADMIN_USERNAME must contain 1 to 12 bytes without surrounding whitespace")
		}
		if !passwordSet {
			return errors.New("INITIAL_ADMIN_PASSWORD must be set with INITIAL_ADMIN_USERNAME")
		}
		hashedPassword, err := common.HashAccountPassword(password)
		if err != nil {
			return fmt.Errorf("invalid INITIAL_ADMIN_PASSWORD configuration: %w", err)
		}
		admin := User{
			Username:    username,
			Password:    hashedPassword,
			Role:        common.RoleRootUser,
			Status:      common.UserStatusEnabled,
			DisplayName: "Root User",
			Quota:       100000000,
		}
		if err := tx.Create(&admin).Error; err != nil {
			return fmt.Errorf("create initial administrator: %w", err)
		}
		setup := Setup{Version: common.Version, InitializedAt: time.Now().Unix()}
		if err := tx.Create(&setup).Error; err != nil {
			return fmt.Errorf("complete initial administrator setup: %w", err)
		}
		return nil
	})
}

func adminBootstrapAlreadyInitialized(db *gorm.DB) (bool, error) {
	// Include disabled and soft-deleted accounts: bootstrap is not a password
	// recovery or privilege-escalation path for an existing database.
	for _, record := range []any{&Setup{}, &User{}} {
		result := db.Unscoped().Select("id").Limit(1).Find(record)
		if result.Error != nil {
			return false, fmt.Errorf("read administrator initialization state: %w", result.Error)
		}
		if result.RowsAffected != 0 {
			return true, nil
		}
	}
	return false, nil
}
