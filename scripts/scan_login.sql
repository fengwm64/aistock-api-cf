-- 扫码登录状态表（解决 KV 最终一致性问题）
CREATE TABLE IF NOT EXISTS scan_login_states (
    state TEXT PRIMARY KEY,
    status TEXT NOT NULL,     
    openid TEXT,
    jwt TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL  
);

-- 索引：快速查找过期记录
CREATE INDEX IF NOT EXISTS idx_scan_login_expires ON scan_login_states(expires_at);
