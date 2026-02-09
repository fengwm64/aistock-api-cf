import { EmQuoteService } from '../services/EmQuoteService';
import { createResponse } from '../utils/response';
import { formatToChinaTime } from '../utils/datetime';
import { Env } from '../index';
import { isValidAShareSymbol } from '../utils/validator';
import { getStockIdentity } from '../utils/stock';

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
            // 优化：将同步计算提前，即使网络请求失败也能复用逻辑，且减少 await 唤醒后的执行耗时
            const identity = getStockIdentity(symbol);
            const prefix = identity.market === 'unknown' || identity.market === 'bj' ? 'sz' : identity.market;
            const source = `东方财富 https://quote.eastmoney.com/concept/${prefix}${symbol}.html?from=classic`;

            const data = await EmQuoteService.getQuote(symbol);

            return createResponse(200, 'success', {
                '来源': source,
                '更新时间': formatToChinaTime(Date.now()),
                ...data,
            });
        } catch (err: any) {
            console.error(`Error fetching quote for ${symbol}:`, err);
            return createResponse(500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }
}
