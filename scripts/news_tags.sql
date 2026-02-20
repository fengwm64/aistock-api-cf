CREATE TABLE IF NOT EXISTS news_tags (
    news_id TEXT NOT NULL CHECK (length(trim(news_id)) > 0),
    tag_code TEXT NOT NULL,
    effect_type TEXT NOT NULL CHECK (effect_type IN ('利好', '利空')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (news_id, tag_code),

    FOREIGN KEY (tag_code) REFERENCES tags(tag_code)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

-- 场景：给定 news_id，快速拿到利好/利空标签
CREATE INDEX IF NOT EXISTS idx_news_tags_news_effect_created
ON news_tags(news_id, effect_type, created_at DESC);
