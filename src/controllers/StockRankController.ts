import { EmStockRankService } from '../services/EmStockRankService';
import { CacheService } from '../services/CacheService';
import { createResponse } from '../utils/response';
import { formatToChinaTime } from '../utils/datetime';
import { Env } from '../index';

/**
 * 热门人气榜控制器
 */
export class StockRankController {
    /** 缓存 TTL: 10分钟 */
    private static readonly CACHE_TTL = 10 * 60;
    private static readonly CACHE_KEY = 'stock_hot_rank';

    static async getHotRank(env: Env, ctx: ExecutionContext) {
        try {
            const source = '东方财富 http://guba.eastmoney.com/rank/';
            let cachedWrapper: any = null;
            let cacheService: CacheService | null = null;

            if (env.AISTOCK) {
                cacheService = new CacheService(env.AISTOCK, ctx);
                cachedWrapper = await cacheService.get(this.CACHE_KEY);
            }

            // 命中缓存
            if (cachedWrapper?.timestamp && cachedWrapper?.data) {
                cacheService?.refresh(this.CACHE_KEY, cachedWrapper, this.CACHE_TTL);

                return createResponse(200, 'success (cached)', {
                    '来源': source,
                    '更新时间': formatToChinaTime(cachedWrapper.timestamp),
                    ...cachedWrapper.data,
                });
            }

            // 未命中缓存：请求源数据
            const rankList = await EmStockRankService.getStockHotRank();
            const now = Date.now();
            const data = { '人气榜': rankList };

            if (cacheService) {
                cacheService.set(this.CACHE_KEY, { timestamp: now, data }, this.CACHE_TTL);
            }

            return createResponse(200, 'success', {
                '来源': source,
                '更新时间': formatToChinaTime(now),
                ...data,
            });
        } catch (err: any) {
            console.error('Error fetching stock hot rank:', err);
            return createResponse(500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }
}
