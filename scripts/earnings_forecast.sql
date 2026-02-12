CREATE TABLE IF NOT EXISTS earnings_forecast (
    symbol TEXT NOT NULL,
    update_time DATETIME NOT NULL,
    summary TEXT,
    forecast_detail JSON NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (symbol, update_time),

    FOREIGN KEY (symbol) REFERENCES stocks(symbol)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_earnings_forecast_update_time
ON earnings_forecast(update_time);
