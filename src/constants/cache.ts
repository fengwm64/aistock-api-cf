import type { StockRankResult } from '../services/EmStockRankService';

export const HOT_STOCKS_CACHE_KEY = 'hot_stocks:v1';
export const HOT_STOCKS_CACHE_TTL_SECONDS = 30 * 60;
export const DEFAULT_CRON_HOT_TOPN = 8;
export const MAX_CRON_HOT_TOPN = 100;
export const HOT_STOCKS_SOURCE = '东方财富 https://guba.eastmoney.com/rank/';
export const HOT_STOCK_INFO_WARMUP_TOPN = 8;
export const STOCK_INFO_CACHE_KEY_PREFIX = 'stock_info:';
export const STOCK_INFO_CACHE_TTL_SECONDS = 14 * 24 * 60 * 60;
export const INDEX_QUOTE_CACHE_KEY_PREFIX = 'index_quote:';
export const INDEX_QUOTE_CACHE_TTL_SECONDS = 5 * 60;

export interface HotStocksCachePayload {
    timestamp: number;
    generatedAt: string;
    source: string;
    topN: number;
    symbols: string[];
    hotStocks: StockRankResult[];
}

export interface StockInfoCachePayload {
    timestamp: number;
    data: Record<string, any>;
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

export function isValidStockInfoCachePayload(value: unknown): value is StockInfoCachePayload {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const payload = value as Record<string, unknown>;
    if (typeof payload.timestamp !== 'number' || !Number.isFinite(payload.timestamp)) return false;
    if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) return false;
    return true;
}
