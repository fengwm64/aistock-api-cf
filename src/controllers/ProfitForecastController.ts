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
                    updateTime: formatToChinaTime(cachedWrapper.timestamp),
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
                updateTime: formatToChinaTime(now),
                ...data,
            });
        } catch (error: any) {
            return createResponse(500, error.message);
        }
    }
}
