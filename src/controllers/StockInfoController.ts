import { EmService } from '../services/EmInfoService';
import { CacheService } from '../services/CacheService';
import { createResponse } from '../utils/response';
import { formatToChinaTime } from '../utils/datetime';
import { Env } from '../index';
import { isValidAShareSymbol } from '../utils/validator';
import { getStockIdentity } from '../utils/stock';

/** 单次最多查询股票数量 */
const MAX_SYMBOLS = 20;

/**
 * 股票基本信息控制器
 */
export class StockInfoController {
    /** 缓存 TTL: 14天 */
    private static readonly CACHE_TTL = 14 * 24 * 60 * 60;

    static async getStockInfo(symbol: string, env: Env, ctx: ExecutionContext) {
        if (!symbol) {
            return createResponse(400, '缺少 symbol 参数');
        }
        if (!isValidAShareSymbol(symbol)) {
            return createResponse(400, 'Invalid symbol - A股代码必须是6位数字');
        }

        const cacheKey = `stock_info:${symbol}`;
        // 根据股票代码判断交易所前缀
        const identity = getStockIdentity(symbol);
        const prefix = identity.market === 'unknown' || identity.market === 'bj' ? 'sz' : identity.market;
        const source = `东方财富 http://quote.eastmoney.com/concept/${prefix}${symbol}.html?from=classic`;

        try {
            let cachedWrapper: any = null;
            let cacheService: CacheService | null = null;

            if (env.KV) {
                cacheService = new CacheService(env.KV, ctx);
                cachedWrapper = await cacheService.get(cacheKey);
            }

            // 命中缓存（新格式: { timestamp, data }）
            if (cachedWrapper?.timestamp && cachedWrapper?.data) {
                cacheService?.refresh(cacheKey, cachedWrapper, this.CACHE_TTL);

                return createResponse(200, 'success (cached)', {
                    '来源': source,
                    '更新时间': formatToChinaTime(cachedWrapper.timestamp),
                    ...cachedWrapper.data,
                });
            }

            // 未命中缓存：请求源数据
            const data = await EmService.getStockInfo(symbol);
            const now = Date.now();

            if (cacheService && Object.keys(data).length > 0) {
                cacheService.set(cacheKey, { timestamp: now, data }, this.CACHE_TTL);
            }

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
            const results = await EmService.getBatchStockInfo(symbols);
            const now = Date.now();

            return createResponse(200, 'success', {
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
