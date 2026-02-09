import { EmService } from '../services/EmService';
import { CacheService } from '../services/CacheService';
import { createResponse } from '../utils/response';
import { formatToChinaTime } from '../utils/datetime';
import { Env } from '../index';
import { isValidAShareSymbol } from '../utils/validator';
import { getStockIdentity } from '../utils/stock';

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

            if (env.AISTOCK) {
                cacheService = new CacheService(env.AISTOCK, ctx);
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
}
