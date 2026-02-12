CREATE TABLE IF NOT EXISTS stock_analysis (
    symbol TEXT NOT NULL,
    analysis_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    conclusion TEXT NOT NULL CHECK (
        conclusion IN ('重大利好', '利好', '中性', '利空', '重大利空')
    ),
    
    core_logic TEXT NOT NULL,
    risk_warning TEXT NOT NULL,

    PRIMARY KEY (symbol, analysis_time),

    FOREIGN KEY (symbol) REFERENCES stocks(symbol)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

-- 查询优化索引
CREATE INDEX IF NOT EXISTS idx_stock_analysis_time
ON stock_analysis(analysis_time);
