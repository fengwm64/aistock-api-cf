import { getStockIdentity } from '../utils/stock';
import { formatToChinaTime } from '../utils/datetime';
import { createResponse } from '../utils/response';
import { isValidAShareSymbol, isValidGlobalIndexSymbol } from '../utils/validator';
import { Env } from '../index';
import { eastmoneyThrottler } from '../utils/throttlers';
import {
    INDEX_QUOTE_CACHE_KEY_PREFIX,
    isValidStockInfoCachePayload,
} from '../constants/cache';
import { getAShareIndexCacheTtlSeconds } from '../utils/tradingTime';

/** 单次最多查询数量 */
const MAX_SYMBOLS = 20;

/** 请求字段 */
const INDEX_FIELDS = 'f57,f58,f43,f44,f45,f46,f47,f48,f60,f170,f169,f168,f296,f86';

/** 字段编号 -> 中文名称 */
const FIELD_NAME_MAP: Record<string, string> = {
    'f57': '指数代码',
    'f58': '指数简称',
    'f43': '最新价',
    'f44': '最高价',
    'f45': '最低价',
    'f46': '今开价',
    'f47': '成交量',
    'f48': '成交额',
    'f60': '昨收价',
    'f170': '涨跌幅',
    'f169': '涨跌额',
    'f168': '换手率',
    'f296': '成交笔数',
    'f86': '更新时间',
};

const BASE_URL = 'https://push2.eastmoney.com/api/qt/stock/get';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Referer': 'https://quote.eastmoney.com/',
};

interface CachedQuoteResult {
    quote: Record<string, any>;
    fromCache: boolean;
}

/**
 * 获取单只指数行情
 */
async function getIndexQuote(symbol: string): Promise<Record<string, any>> {
    // 通过股票代码得到 eastmoneyId，然后取反得到指数的 eastmoneyId
    const { eastmoneyId } = getStockIdentity(symbol);
    const indexId = eastmoneyId === 1 ? 0 : 1;

    const url = `${BASE_URL}?invt=2&fltt=2&fields=${INDEX_FIELDS}&secid=${indexId}.${symbol}`;
    
    // 限流 (东方财富)
    await eastmoneyThrottler.throttle();

    const response = await fetch(url, { headers: HEADERS });

    if (!response.ok) {
        throw new Error(`东方财富指数接口请求失败: ${response.status}`);
    }

    const json: any = await response.json();
    const innerData = json.data;

    if (!innerData) {
        throw new Error(`指数 ${symbol} 数据不存在`);
    }

    const result: Record<string, any> = {};

    for (const [key, name] of Object.entries(FIELD_NAME_MAP)) {
        if (!(key in innerData)) continue;
        let value = innerData[key];

        if (key === 'f47' && typeof value === 'number') {
            value = value * 100; // 手 -> 股
        } else if (key === 'f86' && typeof value === 'number') {
            value = formatToChinaTime(value * 1000);
        }

        result[name] = value;
    }

    return result;
}

/**
 * 获取单只全球指数行情
 * 支持智能市场ID选择和降级机制
 */
async function getGlobalIndexQuote(symbol: string): Promise<Record<string, any>> {
    // 智能选择市场 ID
    // HS 开头的恒生相关指数使用 124
    // 其他指数使用 100
    const isHangSeng = symbol.startsWith('HS');
    const primaryMarketId = isHangSeng ? 124 : 100;
    const fallbackMarketId = 251; // 降级市场 ID（用于特殊指数如纳斯达克中国金龙等）

    // 尝试主市场 ID
    const primaryUrl = `${BASE_URL}?invt=2&fltt=2&fields=${INDEX_FIELDS}&secid=${primaryMarketId}.${symbol}`;
    
    // 限流 (东方财富)
    await eastmoneyThrottler.throttle();

    let response = await fetch(primaryUrl, { headers: HEADERS });

    if (!response.ok) {
        throw new Error(`东方财富指数接口请求失败: ${response.status}`);
    }

    let json: any = await response.json();
    let innerData = json.data;

    // 如果主市场 ID 没有数据且不是恒生指数，尝试降级到 251
    if (!innerData && !isHangSeng) {
        const fallbackUrl = `${BASE_URL}?invt=2&fltt=2&fields=${INDEX_FIELDS}&secid=${fallbackMarketId}.${symbol}`;
        
        // 限流 (东方财富)
        await eastmoneyThrottler.throttle();
        
        response = await fetch(fallbackUrl, { headers: HEADERS });

        if (!response.ok) {
            throw new Error(`东方财富指数接口请求失败: ${response.status}`);
        }

        json = await response.json();
        innerData = json.data;
    }

    if (!innerData) {
        throw new Error(`指数 ${symbol} 数据不存在`);
    }

    const result: Record<string, any> = {};

    for (const [key, name] of Object.entries(FIELD_NAME_MAP)) {
        if (!(key in innerData)) continue;
        let value = innerData[key];

        if (key === 'f47' && typeof value === 'number') {
            value = value * 100; // 手 -> 股
        } else if (key === 'f86' && typeof value === 'number') {
            value = formatToChinaTime(value * 1000);
        }

        result[name] = value;
    }

    return result;
}

/**
 * 指数实时行情控制器
 */
export class IndexQuoteController {
    private static readonly DEFAULT_CRON_CN_INDEX_SYMBOLS = ['000001', '399001', '399006'] as const;
    private static readonly DEFAULT_CRON_GB_INDEX_SYMBOLS = ['HXC', 'XIN9', 'HSTECH'] as const;

    private static buildIndexCacheKey(market: 'cn' | 'gb', symbol: string): string {
        return `${INDEX_QUOTE_CACHE_KEY_PREFIX}${market}:${symbol.toUpperCase()}`;
    }

    private static async readCachedQuote(
        market: 'cn' | 'gb',
        symbol: string,
        env: Env,
    ): Promise<Record<string, any> | null> {
        if (!env.KV) return null;

        const cacheKey = this.buildIndexCacheKey(market, symbol);
        try {
            const cached = await env.KV.get(cacheKey, 'json');
            if (!isValidStockInfoCachePayload(cached)) return null;
            return cached.data;
        } catch (err) {
            console.error(`Error reading index quote cache ${cacheKey}:`, err);
            return null;
        }
    }

    private static async writeCachedQuote(
        market: 'cn' | 'gb',
        symbol: string,
        quote: Record<string, any>,
        env: Env,
        ttlSeconds?: number,
    ): Promise<void> {
        if (!env.KV || Object.keys(quote).length === 0) return;

        const resolvedTtl = ttlSeconds ?? await getAShareIndexCacheTtlSeconds();
        const cacheKey = this.buildIndexCacheKey(market, symbol);
        try {
            await env.KV.put(cacheKey, JSON.stringify({ timestamp: Date.now(), data: quote }), {
                expirationTtl: resolvedTtl,
            });
        } catch (err) {
            console.error(`Error writing index quote cache ${cacheKey}:`, err);
        }
    }

    private static async getCnQuoteWithCache(symbol: string, env: Env): Promise<CachedQuoteResult> {
        const cached = await this.readCachedQuote('cn', symbol, env);
        if (cached) {
            return { quote: cached, fromCache: true };
        }

        const quote = await getIndexQuote(symbol);
        await this.writeCachedQuote('cn', symbol, quote, env);
        return { quote, fromCache: false };
    }

    private static async getGbQuoteWithCache(symbol: string, env: Env): Promise<CachedQuoteResult> {
        const cached = await this.readCachedQuote('gb', symbol, env);
        if (cached) {
            return { quote: cached, fromCache: true };
        }

        const quote = await getGlobalIndexQuote(symbol);
        await this.writeCachedQuote('gb', symbol, quote, env);
        return { quote, fromCache: false };
    }

    static async refreshPresetIndexQuotes(env: Env): Promise<void> {
        if (!env.KV) {
            console.warn('[Cron][IndexWarmup] KV binding is missing, skip warmup');
            return;
        }

        const cnSymbols = this.parseCronCnSymbols(env.CRON_CN_INDEX_SYMBOLS);
        const gbSymbols = this.parseCronGbSymbols(env.CRON_GB_INDEX_SYMBOLS);
        const ttlSeconds = await getAShareIndexCacheTtlSeconds();
        const tasks: Promise<void>[] = [];

        for (const symbol of cnSymbols) {
            tasks.push((async () => {
                const quote = await getIndexQuote(symbol);
                await this.writeCachedQuote('cn', symbol, quote, env, ttlSeconds);
            })());
        }

        for (const symbol of gbSymbols) {
            tasks.push((async () => {
                const quote = await getGlobalIndexQuote(symbol);
                await this.writeCachedQuote('gb', symbol, quote, env, ttlSeconds);
            })());
        }

        const results = await Promise.allSettled(tasks);
        const failed = results.filter(item => item.status === 'rejected').length;
        const succeeded = results.length - failed;

        if (failed > 0) {
            console.error(`[Cron][IndexWarmup] done with partial failures: ok=${succeeded}, failed=${failed}`);
            return;
        }

        console.log(`[Cron][IndexWarmup] refreshed index caches: total=${results.length}`);
    }

    private static parseCronCnSymbols(raw: string | undefined): string[] {
        const fallback = Array.from(this.DEFAULT_CRON_CN_INDEX_SYMBOLS);
        if (!raw || !raw.trim()) return fallback;

        const parsed = Array.from(new Set(
            raw.split(',').map(item => item.trim()).filter(Boolean),
        ));

        const valid = parsed.filter(isValidAShareSymbol);
        return valid.length > 0 ? valid.slice(0, MAX_SYMBOLS) : fallback;
    }

    private static parseCronGbSymbols(raw: string | undefined): string[] {
        const fallback = Array.from(this.DEFAULT_CRON_GB_INDEX_SYMBOLS);
        if (!raw || !raw.trim()) return fallback;

        const parsed = Array.from(new Set(
            raw
                .split(',')
                .map(item => item.trim().toUpperCase())
                .filter(Boolean),
        ));

        const valid = parsed.filter(isValidGlobalIndexSymbol);
        return valid.length > 0 ? valid.slice(0, MAX_SYMBOLS) : fallback;
    }

    static async getIndexQuotes(request: Request, env: Env, ctx: ExecutionContext) {
        const url = new URL(request.url);
        const symbolsParam = url.searchParams.get('symbols');

        if (!symbolsParam) {
            return createResponse(400, '缺少 symbols 参数，示例: ?symbols=000001,399006');
        }

        const symbols = [...new Set(symbolsParam.split(',').map(s => s.trim()).filter(Boolean))];

        if (symbols.length === 0) {
            return createResponse(400, '缺少 symbols 参数，示例: ?symbols=000001,399006');
        }

        if (symbols.length > MAX_SYMBOLS) {
            return createResponse(400, `单次最多查询 ${MAX_SYMBOLS} 只指数`);
        }

        const invalidSymbols = symbols.filter(s => !isValidAShareSymbol(s));
        if (invalidSymbols.length > 0) {
            return createResponse(400, `Invalid symbol(s) - 指数代码必须是6位数字: ${invalidSymbols.join(', ')}`);
        }

        try {
            const quoteResults = await Promise.all(symbols.map(async (symbol) => {
                try {
                    return await this.getCnQuoteWithCache(symbol, env);
                } catch (err: any) {
                    return {
                        quote: { '指数代码': symbol, '错误': err?.message || '查询失败' },
                        fromCache: false,
                    };
                }
            }));
            const allFromCache = quoteResults.every(item => item.fromCache);
            const quotes = quoteResults.map(item => item.quote);

            return createResponse(200, allFromCache ? 'success (cached)' : 'success', {
                '来源': '东方财富',
                '指数数量': quotes.length,
                '行情': quotes,
            });
        } catch (err: any) {
            return createResponse(500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }

    static async getGlobalIndexQuotes(request: Request, env: Env, ctx: ExecutionContext) {
        const url = new URL(request.url);
        const symbolsParam = url.searchParams.get('symbols');

        if (!symbolsParam) {
            return createResponse(400, '缺少 symbols 参数，示例: ?symbols=HXC,XIN9,HSTECH');
        }

        const symbols = [...new Set(symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean))];

        if (symbols.length === 0) {
            return createResponse(400, '缺少 symbols 参数，示例: ?symbols=HXC,XIN9,HSTECH');
        }

        if (symbols.length > MAX_SYMBOLS) {
            return createResponse(400, `单次最多查询 ${MAX_SYMBOLS} 只指数`);
        }

        const invalidSymbols = symbols.filter(s => !isValidGlobalIndexSymbol(s));
        if (invalidSymbols.length > 0) {
            return createResponse(400, `Invalid symbol(s) - 全球指数代码格式错误: ${invalidSymbols.join(', ')}`);
        }

        try {
            const quoteResults = await Promise.all(symbols.map(async (symbol) => {
                try {
                    return await this.getGbQuoteWithCache(symbol, env);
                } catch (err: any) {
                    return {
                        quote: { '指数代码': symbol, '错误': err?.message || '查询失败' },
                        fromCache: false,
                    };
                }
            }));
            const allFromCache = quoteResults.every(item => item.fromCache);
            const quotes = quoteResults.map(item => item.quote);

            return createResponse(200, allFromCache ? 'success (cached)' : 'success', {
                '来源': '东方财富',
                '指数数量': quotes.length,
                '行情': quotes,
            });
        } catch (err: any) {
            return createResponse(500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }
}
