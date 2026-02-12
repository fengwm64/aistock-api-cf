CREATE TABLE IF NOT EXISTS user_settings (
    openid TEXT NOT NULL,
    setting_type TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (openid, setting_type),

    FOREIGN KEY (openid) REFERENCES users(openid)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_settings_type_enabled
ON user_settings(setting_type, enabled);
