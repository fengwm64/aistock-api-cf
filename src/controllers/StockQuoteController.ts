import { EmQuoteService } from '../services/EmQuoteService';
import { createResponse } from '../utils/response';
import { formatToChinaTime } from '../utils/datetime';
import { Env } from '../index';
import { isValidAShareSymbol } from '../utils/validator';

/**
 * 股票实时行情控制器
 * 行情数据实时性要求高，不使用缓存
 */
export class StockQuoteController {
    static async getQuote(symbol: string, env: Env, ctx: ExecutionContext) {
        if (!symbol) {
            return createResponse(400, '缺少 symbol 参数');
        }
        if (!isValidAShareSymbol(symbol)) {
            return createResponse(400, 'Invalid symbol - A股代码必须是6位数字');
        }

        try {
            const data = await EmQuoteService.getQuote(symbol);

            return createResponse(200, 'success', {
                '更新时间': formatToChinaTime(Date.now()),
                ...data,
            });
        } catch (err: any) {
            console.error(`Error fetching quote for ${symbol}:`, err);
            return createResponse(500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }
}
