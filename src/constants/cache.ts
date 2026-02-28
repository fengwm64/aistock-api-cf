import type { StockRankResult } from '../services/EmStockRankService';

export const HOT_STOCKS_CACHE_KEY = 'hot_stocks:v1';
export const HOT_STOCKS_CACHE_TTL_SECONDS = 30 * 60;
export const HOT_STOCKS_SOURCE = '东方财富 https://guba.eastmoney.com/rank/';
export const STOCK_INFO_CACHE_KEY_PREFIX = 'stock_info:';
export const STOCK_INFO_CACHE_TTL_SECONDS = 14 * 24 * 60 * 60;
export const INDEX_QUOTE_CACHE_KEY_PREFIX = 'index_quote:';
export const STOCK_QUOTE_CORE_CACHE_KEY_PREFIX = 'stock_quote:core:';
export const STOCK_QUOTE_ACTIVITY_CACHE_KEY_PREFIX = 'stock_quote:activity:';
export const STOCK_QUOTE_FUNDAMENTAL_CACHE_KEY_PREFIX = 'stock_quote:fundamental:';
export const STOCK_QUOTE_CORE_TRADING_TTL_SECONDS = 60;
export const STOCK_QUOTE_ACTIVITY_TRADING_TTL_SECONDS = 60;
export const STOCK_QUOTE_FUNDAMENTAL_TRADING_TTL_SECONDS = 60;

export interface TimestampedCachePayload<TData = Record<string, any>> {
    timestamp: number;
    data: TData;
}

export interface HotStocksCachePayload {
    timestamp: number;
    generatedAt: string;
    source: string;
    topN: number;
    symbols: string[];
    hotStocks: StockRankResult[];
}

export type StockInfoCachePayload = TimestampedCachePayload<Record<string, any>>;

export function buildStockInfoCacheKey(symbol: string): string {
    return `${STOCK_INFO_CACHE_KEY_PREFIX}${symbol}`;
}

export function buildTimestampedCachePayload<TData>(
    data: TData,
    timestamp: number = Date.now(),
): TimestampedCachePayload<TData> {
    return { timestamp, data };
}

export function isValidTimestampedRecordCachePayload(
    value: unknown,
): value is TimestampedCachePayload<Record<string, any>> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const payload = value as Record<string, unknown>;
    if (typeof payload.timestamp !== 'number' || !Number.isFinite(payload.timestamp)) return false;
    if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) return false;
    return true;
}

export function isValidStockInfoCachePayload(value: unknown): value is StockInfoCachePayload {
    return isValidTimestampedRecordCachePayload(value);
}
