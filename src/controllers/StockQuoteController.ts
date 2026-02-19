import { EmQuoteService, QuoteLevel } from '../services/EmQuoteService';
import { EmKlineService, KLineFqt, KLinePeriod } from '../services/EmKlineService';
import { createResponse } from '../utils/response';
import { Env } from '../index';
import { isValidAShareSymbol } from '../utils/validator';
import {
    STOCK_QUOTE_CORE_CACHE_KEY_PREFIX,
    STOCK_QUOTE_CORE_TRADING_TTL_SECONDS,
    STOCK_QUOTE_FUNDAMENTAL_CACHE_KEY_PREFIX,
    STOCK_QUOTE_FUNDAMENTAL_TRADING_TTL_SECONDS,
    isValidStockInfoCachePayload,
} from '../constants/cache';
import { getAShareAdaptiveCacheTtlSeconds } from '../utils/tradingTime';

/** 单次最多查询股票数量 */
const MAX_SYMBOLS = 20;
/** K 线单次最多返回数量 */
const MAX_KLINE_LIMIT = 5000;
/** 支持的 K 线周期 */
const SUPPORTED_KLT = new Set<number>([1, 5, 15, 30, 60, 101, 102, 103]);

interface QuoteCacheConfig {
    keyPrefix: string;
    tradingTtlSeconds: number;
}

/**
 * 股票行情控制器
 * 缓存策略：
 * - core/fundamental：读 KV 优先，未命中回源并回填
 * - activity/kline：实时回源
 * 支持接口:
 *   /api/cn/stock/quotes/core?symbols=...         核心行情
 *   /api/cn/stock/quotes/activity?symbols=...      盘口/活跃度
 *   /api/cn/stock/quotes/kline?symbol=...          历史 K 线
 *   /api/cn/stock/fundamentals?symbols=...         估值/基本面
 */
export class StockQuoteController {
    private static parseIntegerParam(value: string | null): number | null {
        if (value === null || value === '') return null;
        if (!/^-?\d+$/.test(value)) return null;
        return Number(value);
    }

    private static getKLinePeriodName(klt: KLinePeriod): string {
        const periodMap: Record<KLinePeriod, string> = {
            1: '1分钟',
            5: '5分钟',
            15: '15分钟',
            30: '30分钟',
            60: '60分钟',
            101: '日线',
            102: '周线',
            103: '月线',
        };
        return periodMap[klt];
    }

    private static getFqtName(fqt: KLineFqt): string {
        const fqtMap: Record<KLineFqt, string> = {
            0: '不复权',
            1: '前复权',
            2: '后复权',
        };
        return fqtMap[fqt];
    }

    private static getQuoteCacheConfig(level: QuoteLevel): QuoteCacheConfig | null {
        if (level === 'core') {
            return {
                keyPrefix: STOCK_QUOTE_CORE_CACHE_KEY_PREFIX,
                tradingTtlSeconds: STOCK_QUOTE_CORE_TRADING_TTL_SECONDS,
            };
        }
        if (level === 'fundamental') {
            return {
                keyPrefix: STOCK_QUOTE_FUNDAMENTAL_CACHE_KEY_PREFIX,
                tradingTtlSeconds: STOCK_QUOTE_FUNDAMENTAL_TRADING_TTL_SECONDS,
            };
        }
        return null;
    }

    private static buildQuoteCacheKey(level: QuoteLevel, symbol: string): string | null {
        const config = this.getQuoteCacheConfig(level);
        if (!config) return null;
        return `${config.keyPrefix}${symbol}`;
    }

    private static async readCachedQuote(level: QuoteLevel, symbol: string, env: Env): Promise<Record<string, any> | null> {
        if (!env.KV) return null;

        const cacheKey = this.buildQuoteCacheKey(level, symbol);
        if (!cacheKey) return null;

        try {
            const cached = await env.KV.get(cacheKey, 'json');
            if (!isValidStockInfoCachePayload(cached)) return null;
            return cached.data;
        } catch (err) {
            console.error(`Error reading stock quote cache ${cacheKey}:`, err);
            return null;
        }
    }

    private static async writeCachedQuote(
        level: QuoteLevel,
        symbol: string,
        quote: Record<string, any>,
        env: Env,
        ttlSeconds: number,
    ): Promise<void> {
        if (!env.KV || Object.keys(quote).length === 0) return;

        const cacheKey = this.buildQuoteCacheKey(level, symbol);
        if (!cacheKey) return;

        try {
            await env.KV.put(cacheKey, JSON.stringify({ timestamp: Date.now(), data: quote }), {
                expirationTtl: ttlSeconds,
            });
        } catch (err) {
            console.error(`Error writing stock quote cache ${cacheKey}:`, err);
        }
    }

    private static isCacheableQuote(quote: Record<string, any>): boolean {
        if (!quote || typeof quote !== 'object' || Array.isArray(quote)) return false;
        if (Object.keys(quote).length === 0) return false;
        return !('错误' in quote);
    }

    /** 通用批量查询逻辑 */
    private static async handleBatchQuotes(request: Request, level: QuoteLevel, env: Env) {
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
            const cacheConfig = this.getQuoteCacheConfig(level);
            if (!cacheConfig || !env.KV) {
                const results = await EmQuoteService.getBatchQuotes(symbols, level);

                return createResponse(200, 'success', {
                    '来源': '东方财富',
                    '股票数量': results.length,
                    '行情': results,
                });
            }

            const quotesBySymbol = new Map<string, Record<string, any>>();
            const cacheChecks = await Promise.all(symbols.map(async (symbol) => {
                const cached = await this.readCachedQuote(level, symbol, env);
                return { symbol, cached };
            }));

            const missedSymbols: string[] = [];
            for (const item of cacheChecks) {
                if (item.cached) {
                    quotesBySymbol.set(item.symbol, item.cached);
                    continue;
                }
                missedSymbols.push(item.symbol);
            }

            if (missedSymbols.length > 0) {
                const fetchedQuotes = await EmQuoteService.getBatchQuotes(missedSymbols, level);
                const cacheableFetchedCount = fetchedQuotes.filter(quote => this.isCacheableQuote(quote)).length;
                const cacheTtlSeconds = cacheableFetchedCount > 0
                    ? await getAShareAdaptiveCacheTtlSeconds(cacheConfig.tradingTtlSeconds)
                    : null;

                const writeTasks: Promise<void>[] = [];
                fetchedQuotes.forEach((quote, index) => {
                    const symbol = missedSymbols[index];
                    quotesBySymbol.set(symbol, quote);

                    if (cacheTtlSeconds !== null && this.isCacheableQuote(quote)) {
                        writeTasks.push(this.writeCachedQuote(level, symbol, quote, env, cacheTtlSeconds));
                    }
                });

                if (writeTasks.length > 0) {
                    await Promise.all(writeTasks);
                }
            }

            const results = symbols.map(symbol => (
                quotesBySymbol.get(symbol) ?? { '股票代码': symbol, '错误': '查询失败' }
            ));
            const message = missedSymbols.length === 0 ? 'success (cached)' : 'success';

            return createResponse(200, message, {
                '来源': '东方财富',
                '股票数量': results.length,
                '行情': results,
            });
        } catch (err: any) {
            console.error(`Error fetching ${level} batch quotes:`, err);
            return createResponse(500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }

    /** 一级：核心行情 */
    static async getCoreQuotes(request: Request, env: Env, ctx: ExecutionContext) {
        return this.handleBatchQuotes(request, 'core', env);
    }

    /** 二级：盘口/活跃度 */
    static async getActivityQuotes(request: Request, env: Env, ctx: ExecutionContext) {
        return this.handleBatchQuotes(request, 'activity', env);
    }

    /** 三级：估值/基本面 */
    static async getFundamentalQuotes(request: Request, env: Env, ctx: ExecutionContext) {
        return this.handleBatchQuotes(request, 'fundamental', env);
    }

    /** K 线行情 */
    static async getKLine(request: Request, env: Env, ctx: ExecutionContext) {
        const url = new URL(request.url);
        const symbol = (url.searchParams.get('symbol') || '').trim();
        const kltParam = url.searchParams.get('klt');
        const fqtParam = url.searchParams.get('fqt');
        const limitParam = url.searchParams.get('limit');
        const startDate = (url.searchParams.get('startDate') || '').trim();
        const endDate = (url.searchParams.get('endDate') || '').trim();

        if (!symbol) {
            return createResponse(400, '缺少 symbol 参数，示例: ?symbol=000001');
        }

        if (!isValidAShareSymbol(symbol)) {
            return createResponse(400, 'Invalid symbol - A股代码必须是6位数字');
        }

        let klt: KLinePeriod = 101;
        if (kltParam !== null && kltParam !== '') {
            const parsedKlt = this.parseIntegerParam(kltParam);
            if (parsedKlt === null || !SUPPORTED_KLT.has(parsedKlt)) {
                return createResponse(400, 'Invalid klt - klt 仅支持 1/5/15/30/60/101/102/103');
            }
            klt = parsedKlt as KLinePeriod;
        }

        const defaultFqt: KLineFqt = klt >= 100 ? 1 : 0;
        let fqt: KLineFqt = defaultFqt;
        if (fqtParam !== null && fqtParam !== '') {
            const parsedFqt = this.parseIntegerParam(fqtParam);
            if (parsedFqt !== 0 && parsedFqt !== 1 && parsedFqt !== 2) {
                return createResponse(400, 'Invalid fqt - fqt 仅支持 0/1/2');
            }
            fqt = parsedFqt;
        }

        let limit = 1000;
        if (limitParam !== null && limitParam !== '') {
            const parsedLimit = this.parseIntegerParam(limitParam);
            if (parsedLimit === null || !Number.isInteger(parsedLimit) || parsedLimit <= 0 || parsedLimit > MAX_KLINE_LIMIT) {
                return createResponse(400, `Invalid limit - limit 必须是 1-${MAX_KLINE_LIMIT} 的整数`);
            }
            limit = parsedLimit;
        }

        if (startDate && !/^\d{8}$/.test(startDate)) {
            return createResponse(400, 'Invalid startDate - startDate 格式必须为 YYYYMMDD');
        }
        if (endDate && !/^\d{8}$/.test(endDate)) {
            return createResponse(400, 'Invalid endDate - endDate 格式必须为 YYYYMMDD');
        }
        if (startDate && endDate && startDate > endDate) {
            return createResponse(400, 'Invalid date range - startDate 不能晚于 endDate');
        }

        try {
            const klines = await EmKlineService.getKLine({
                symbol,
                klt,
                fqt,
                limit,
                startDate: startDate || undefined,
                endDate: endDate || undefined,
            });

            return createResponse(200, 'success', {
                '来源': '东方财富',
                '股票代码': symbol,
                'K线周期': this.getKLinePeriodName(klt),
                '复权类型': this.getFqtName(fqt),
                '数量': klines.length,
                'K线': klines,
            });
        } catch (err: any) {
            console.error(`Error fetching kline for ${symbol}:`, err);
            return createResponse(500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }
}
