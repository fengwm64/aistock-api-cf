import { EmStockRankService } from '../services/EmStockRankService';
import { createResponse } from '../utils/response';
import { formatToChinaTime } from '../utils/datetime';
import { Env } from '../index';
import {
    HOT_STOCKS_CACHE_KEY,
    HOT_STOCKS_CACHE_TTL_SECONDS,
    HOT_STOCKS_SOURCE,
    type HotStocksCachePayload,
} from '../constants/cache';

/**
 * 热门人气榜控制器
 */
export class StockRankController {
    private static readonly DEFAULT_COUNT = 8;
    private static readonly MAX_COUNT = 100;

    private static isValidCachedPayload(value: unknown): value is HotStocksCachePayload {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const payload = value as Record<string, unknown>;
        if (typeof payload.timestamp !== 'number' || !Number.isFinite(payload.timestamp)) return false;
        if (typeof payload.source !== 'string' || !payload.source) return false;
        if (!Array.isArray(payload.hotStocks)) return false;
        return true;
    }

    private static async getCachedHotStocks(env: Env): Promise<HotStocksCachePayload | null> {
        if (!env.KV) return null;

        try {
            const cached = await env.KV.get<HotStocksCachePayload>(HOT_STOCKS_CACHE_KEY, 'json');
            if (!this.isValidCachedPayload(cached)) return null;
            return cached;
        } catch (err) {
            console.error('Error reading hot stocks cache:', err);
            return null;
        }
    }

    private static async writeHotStocksCache(env: Env, rankList: Awaited<ReturnType<typeof EmStockRankService.getStockHotRank>>): Promise<void> {
        if (!env.KV) return;

        const hotStocks = rankList.slice(0, this.MAX_COUNT);
        const payload: HotStocksCachePayload = {
            timestamp: Date.now(),
            generatedAt: new Date().toISOString(),
            source: HOT_STOCKS_SOURCE,
            topN: hotStocks.length,
            symbols: hotStocks.map(item => item['股票代码']),
            hotStocks,
        };

        try {
            await env.KV.put(HOT_STOCKS_CACHE_KEY, JSON.stringify(payload), {
                expirationTtl: HOT_STOCKS_CACHE_TTL_SECONDS,
            });
        } catch (err) {
            console.error('Error writing hot stocks cache:', err);
        }
    }

    static async getHotRank(request: Request, env: Env, ctx: ExecutionContext) {
        try {
            const url = new URL(request.url);
            const countParam = url.searchParams.get('count');
            let count = this.DEFAULT_COUNT;

            if (countParam !== null && countParam !== '') {
                const parsed = Number(countParam);
                if (!Number.isInteger(parsed) || parsed <= 0 || parsed > this.MAX_COUNT) {
                    return createResponse(400, `Invalid count - count 必须是 1-${this.MAX_COUNT} 的整数`);
                }
                count = parsed;
            }

            const cached = await this.getCachedHotStocks(env);
            if (cached && cached.hotStocks.length >= count) {
                return createResponse(200, 'success (cached)', {
                    '来源': cached.source,
                    '更新时间': formatToChinaTime(cached.timestamp),
                    '人气榜': cached.hotStocks.slice(0, count),
                });
            }

            const rankList = await EmStockRankService.getStockHotRank();
            const now = Date.now();
            const data = { '人气榜': rankList.slice(0, count) };

            ctx.waitUntil(this.writeHotStocksCache(env, rankList));

            return createResponse(200, 'success', {
                '来源': HOT_STOCKS_SOURCE,
                '更新时间': formatToChinaTime(now),
                ...data,
            });
        } catch (err: any) {
            console.error('Error fetching stock hot rank:', err);
            return createResponse(500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }
}
