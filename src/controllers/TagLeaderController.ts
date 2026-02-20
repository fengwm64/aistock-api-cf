import { EmTagLeaderService } from '../services/EmTagLeaderService';
import { createResponse } from '../utils/response';
import { isValidTagCode } from '../utils/validator';
import { Env } from '../index';

/**
 * 板块龙头控制器
 */
export class TagLeaderController {
    private static readonly DEFAULT_COUNT = 10;
    private static readonly MAX_COUNT = 100;

    static async getTagLeaders(tagCodeParam: string, request: Request, env: Env, ctx: ExecutionContext) {
        const tagCode = tagCodeParam.toUpperCase();
        if (!isValidTagCode(tagCode)) {
            return createResponse(400, 'Invalid tagCode - tagCode 必须是 BK+4位数字，例如 BK0428');
        }

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

        try {
            const leaders = await EmTagLeaderService.getTagLeaders(tagCode, count);
            return createResponse(200, 'success', {
                '来源': '东方财富 https://push2.eastmoney.com/api/qt/clist/get',
                '板块ID': tagCode,
                '排序字段': '主力净流入',
                '排序方式': '降序',
                '数量': leaders.length,
                '龙头个股': leaders,
            });
        } catch (err: any) {
            console.error(`Error fetching tag leaders for ${tagCode}:`, err);
            return createResponse(500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }
}
