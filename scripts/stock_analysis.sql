CREATE TABLE IF NOT EXISTS stock_analysis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    analysis_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    conclusion TEXT NOT NULL CHECK (
        conclusion IN ('重大利好', '利好', '中性', '利空', '重大利空')
    ),
    core_logic TEXT NOT NULL,
    risk_warning TEXT NOT NULL,
    
    FOREIGN KEY (symbol) REFERENCES stocks(symbol)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

-- 建议添加索引（提升查询效率）
CREATE INDEX IF NOT EXISTS idx_stock_analysis_symbol 
ON stock_analysis(symbol);

CREATE INDEX IF NOT EXISTS idx_stock_analysis_time 
ON stock_analysis(analysis_time);
