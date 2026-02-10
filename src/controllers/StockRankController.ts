import { EmStockRankService } from '../services/EmStockRankService';
import { createResponse } from '../utils/response';
import { formatToChinaTime } from '../utils/datetime';
import { Env } from '../index';

/**
 * 热门人气榜控制器
 */
export class StockRankController {
    private static readonly DEFAULT_COUNT = 8;
    private static readonly MAX_COUNT = 100;

    static async getHotRank(request: Request, env: Env, ctx: ExecutionContext) {
        try {
            const source = '东方财富 http://guba.eastmoney.com/rank/';
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

            const rankList = await EmStockRankService.getStockHotRank();
            const now = Date.now();
            const data = { '人气榜': rankList.slice(0, count) };

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
