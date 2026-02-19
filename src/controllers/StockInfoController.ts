import { EmService } from '../services/EmInfoService';
import { CacheService } from '../services/CacheService';
import { createResponse } from '../utils/response';
import { formatToChinaTime } from '../utils/datetime';
import { Env } from '../index';
import { isValidAShareSymbol } from '../utils/validator';
import { getStockIdentity } from '../utils/stock';

/** 单次最多查询股票数量 */
const MAX_SYMBOLS = 20;

interface StockInfoCachePayload {
    timestamp: number;
    data: Record<string, any>;
}

interface BatchStockInfoResult {
    data: Record<string, any>;
    fromCache: boolean;
}

/**
 * 股票基本信息控制器
 */
export class StockInfoController {
    /** 缓存 TTL: 14天 */
    private static readonly CACHE_TTL = 14 * 24 * 60 * 60;

    private static isValidCachePayload(value: unknown): value is StockInfoCachePayload {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const payload = value as Record<string, unknown>;
        if (typeof payload.timestamp !== 'number' || !Number.isFinite(payload.timestamp)) return false;
        if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) return false;
        return true;
    }

    private static getSourceBySymbol(symbol: string): string {
        const { eastmoneyId } = getStockIdentity(symbol);
        const prefix = eastmoneyId === 1 ? 'sh' : 'sz';
        return `东方财富 http://quote.eastmoney.com/concept/${prefix}${symbol}.html?from=classic`;
    }

    private static async fetchAndMaybeCache(
        symbol: string,
        cacheService: CacheService | null,
    ): Promise<Record<string, any>> {
        const data = await EmService.getStockInfo(symbol);

        if (cacheService && Object.keys(data).length > 0) {
            const now = Date.now();
            try {
                cacheService.set(`stock_info:${symbol}`, { timestamp: now, data }, this.CACHE_TTL);
            } catch (err) {
                console.error(`Error writing stock info cache for ${symbol}:`, err);
            }
        }

        return data;
    }

    static async getStockInfo(symbol: string, env: Env, ctx: ExecutionContext) {
        if (!symbol) {
            return createResponse(400, '缺少 symbol 参数');
        }
        if (!isValidAShareSymbol(symbol)) {
            return createResponse(400, 'Invalid symbol - A股代码必须是6位数字');
        }

        const cacheKey = `stock_info:${symbol}`;
        const source = this.getSourceBySymbol(symbol);

        try {
            let cachedWrapper: unknown = null;
            const cacheService = env.KV ? new CacheService(env.KV, ctx) : null;

            if (cacheService) {
                try {
                    cachedWrapper = await cacheService.get<StockInfoCachePayload>(cacheKey);
                } catch (err) {
                    console.error(`Error reading stock info cache for ${symbol}:`, err);
                }
            }

            // 命中缓存：不刷新 TTL（硬过期）
            if (this.isValidCachePayload(cachedWrapper)) {
                return createResponse(200, 'success (cached)', {
                    '来源': source,
                    '更新时间': formatToChinaTime(cachedWrapper.timestamp),
                    ...cachedWrapper.data,
                });
            }

            // 未命中缓存：请求源数据
            const data = await this.fetchAndMaybeCache(symbol, cacheService);
            const now = Date.now();

            return createResponse(200, 'success', {
                '来源': source,
                '更新时间': formatToChinaTime(now),
                ...data,
            });
        } catch (err: any) {
            console.error(`Error fetching stock info for ${symbol}:`, err);
            return createResponse(500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }

    private static async getStockInfoForBatch(
        symbol: string,
        cacheService: CacheService | null,
    ): Promise<BatchStockInfoResult> {
        const cacheKey = `stock_info:${symbol}`;

        if (cacheService) {
            try {
                const cachedWrapper = await cacheService.get<StockInfoCachePayload>(cacheKey);
                if (this.isValidCachePayload(cachedWrapper)) {
                    return {
                        data: cachedWrapper.data,
                        fromCache: true,
                    };
                }
            } catch (err) {
                console.error(`Error reading stock info cache for ${symbol}:`, err);
            }
        }

        try {
            const data = await this.fetchAndMaybeCache(symbol, cacheService);
            return {
                data,
                fromCache: false,
            };
        } catch (err) {
            console.error(`Error fetching info for ${symbol}:`, err);
            return {
                data: {
                    '市场代码': '-',
                    '股票代码': symbol,
                    '股票简称': '-',
                    '错误': err instanceof Error ? err.message : '查询失败',
                },
                fromCache: false,
            };
        }
    }

    /**
     * 批量获取股票基本信息
     */
    static async getBatchStockInfo(request: Request, env: Env, ctx: ExecutionContext) {
        const url = new URL(request.url);
        const symbolsParam = url.searchParams.get('symbols');

        if (!symbolsParam) {
            return createResponse(400, '缺少 symbols 参数，示例: ?symbols=000001,600519');
        }

        const symbols = [...new Set(symbolsParam.split(',').map(s => s.trim()).filter(Boolean))];

        if (symbols.length === 0) {
            return createResponse(400, '缺少 symbols 参数，示例: ?symbols=000001,600519');
        }

        if (symbols.length > MAX_SYMBOLS) {
            return createResponse(400, `单次最多查询 ${MAX_SYMBOLS} 只股票`);
        }

        const invalidSymbols = symbols.filter(s => !isValidAShareSymbol(s));
        if (invalidSymbols.length > 0) {
            return createResponse(400, `Invalid symbol(s) - A股代码必须是6位数字: ${invalidSymbols.join(', ')}`);
        }

        try {
            const cacheService = env.KV ? new CacheService(env.KV, ctx) : null;
            const batchResults = await Promise.all(symbols.map(symbol => this.getStockInfoForBatch(symbol, cacheService)));
            const allFromCache = batchResults.every(item => item.fromCache);
            const results = batchResults.map(item => item.data);
            const now = Date.now();

            return createResponse(200, allFromCache ? 'success (cached)' : 'success', {
                '来源': '东方财富',
                '更新时间': formatToChinaTime(now),
                '股票数量': results.length,
                '股票信息': results,
            });
        } catch (err: any) {
            console.error('Error fetching batch stock info:', err);
            return createResponse(500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }
}
