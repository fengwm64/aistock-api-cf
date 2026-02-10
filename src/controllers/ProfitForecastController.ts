import { ThsService } from '../services/ThsService';
import { CacheService } from '../services/CacheService';
import { createResponse } from '../utils/response';
import { formatToChinaTime } from '../utils/datetime';
import { Env } from '../index';

/**
 * 盈利预测控制器
 */
export class ProfitForecastController {
    /** 缓存 TTL: 7天 */
    private static readonly CACHE_TTL = 7 * 24 * 60 * 60;

    static async getThsForecast(symbol: string, env: Env, ctx: ExecutionContext) {
        if (!symbol) {
            return createResponse(400, '缺少 symbol 参数');
        }

        const cacheKey = `profit_forecast:${symbol}`;
        const source = `同花顺 https://basic.10jqka.com.cn/new/${symbol}/worth.html`;

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
                    '股票代码': symbol,
                    '来源': source,
                    '更新时间': formatToChinaTime(cachedWrapper.timestamp),
                    ...cachedWrapper.data,
                });
            }

            // 未命中缓存：请求源数据
            const data = await ThsService.getProfitForecast(symbol);
            const now = Date.now();

            if (cacheService) {
                cacheService.set(cacheKey, { timestamp: now, data }, this.CACHE_TTL);
            }

            return createResponse(200, 'success', {
                '股票代码': symbol,
                '来源': source,
                '更新时间': formatToChinaTime(now),
                ...data,
            });
        } catch (error: any) {
            return createResponse(500, error.message);
        }
    }
}
