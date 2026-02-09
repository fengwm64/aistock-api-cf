import { EmQuoteService, QuoteLevel } from '../services/EmQuoteService';
import { createResponse } from '../utils/response';
import { Env } from '../index';
import { isValidAShareSymbol } from '../utils/validator';

/** 单次最多查询股票数量 */
const MAX_SYMBOLS = 50;

/**
 * 股票实时行情控制器
 * 行情数据实时性要求高，不使用缓存
 * 支持三级接口:
 *   /api/cn/stock/quotes/core?symbols=...         核心行情
 *   /api/cn/stock/quotes/activity?symbols=...      盘口/活跃度
 *   /api/cn/stock/quotes/fundamental?symbols=...   估值/基本面
 */
export class StockQuoteController {

    /** 通用批量查询逻辑 */
    private static async handleBatchQuotes(request: Request, level: QuoteLevel) {
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
            const results = await EmQuoteService.getBatchQuotes(symbols, level);

            return createResponse(200, 'success', {
                '来源': '东方财富',
                '股票数量': results.length,
                '行情': results,
            });
        } catch (err: any) {
            console.error(`Error fetching ${level} batch quotes:`, err);
            return createResponse(500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }

    /** 一级：核心行情 */
    static async getCoreQuotes(request: Request, env: Env, ctx: ExecutionContext) {
        return this.handleBatchQuotes(request, 'core');
    }

    /** 二级：盘口/活跃度 */
    static async getActivityQuotes(request: Request, env: Env, ctx: ExecutionContext) {
        return this.handleBatchQuotes(request, 'activity');
    }

    /** 三级：估值/基本面 */
    static async getFundamentalQuotes(request: Request, env: Env, ctx: ExecutionContext) {
        return this.handleBatchQuotes(request, 'fundamental');
    }
}
