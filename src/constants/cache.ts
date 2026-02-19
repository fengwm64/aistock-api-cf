import type { StockRankResult } from '../services/EmStockRankService';

export const HOT_STOCKS_CACHE_KEY = 'hot_stocks:v1';
export const HOT_STOCKS_CACHE_TTL_SECONDS = 30 * 60;
export const DEFAULT_CRON_HOT_TOPN = 8;
export const MAX_CRON_HOT_TOPN = 100;
export const HOT_STOCKS_SOURCE = '东方财富 https://guba.eastmoney.com/rank/';

export interface HotStocksCachePayload {
    timestamp: number;
    generatedAt: string;
    source: string;
    topN: number;
    symbols: string[];
    hotStocks: StockRankResult[];
}

export function parsePositiveInteger(value: unknown): number | null {
    const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim());
    if (!Number.isFinite(parsed)) return null;
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    return parsed;
}

export function resolveCronHotTopN(raw: unknown): number {
    const parsed = parsePositiveInteger(raw);
    if (parsed === null) return DEFAULT_CRON_HOT_TOPN;
    return Math.min(MAX_CRON_HOT_TOPN, parsed);
}
