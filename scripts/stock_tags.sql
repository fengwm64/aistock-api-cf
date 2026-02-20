CREATE TABLE IF NOT EXISTS stock_tags (
    symbol TEXT NOT NULL,
    tag_code TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (symbol, tag_code),

    FOREIGN KEY (symbol) REFERENCES stocks(symbol)
        ON DELETE CASCADE
        ON UPDATE CASCADE,

    FOREIGN KEY (tag_code) REFERENCES tags(tag_code)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

-- 场景1：给定标签，反查成分股
CREATE INDEX IF NOT EXISTS idx_stock_tags_tag_symbol
ON stock_tags(tag_code, symbol);

-- 场景2：给定股票，按标签快速遍历
CREATE INDEX IF NOT EXISTS idx_stock_tags_symbol_tag
ON stock_tags(symbol, tag_code);
