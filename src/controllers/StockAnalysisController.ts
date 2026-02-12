import type { Env } from '../index';
import { StockAnalysisService } from '../services/StockAnalysisService';
import { createResponse } from '../utils/response';

/**
 * 个股 AI 评价控制器
 * RESTful 路径: /api/cn/stocks/:symbol/analysis
 */
export class StockAnalysisController {
    static async handleStockAnalysis(symbol: string, request: Request, env: Env, ctx: ExecutionContext) {
        if (!symbol || !/^\d{6}$/.test(symbol)) {
            return createResponse(400, 'Invalid symbol - A股代码必须是6位数字');
        }

        if (request.method === 'POST') {
            try {
                const data = await StockAnalysisService.createStockAnalysis(symbol, env);
                return createResponse(200, 'success', data);
            } catch (error: any) {
                const message = error instanceof Error ? error.message : 'Internal Server Error';
                if (message.includes('股票代码不存在')) {
                    return createResponse(404, message);
                }
                return createResponse(500, message);
            }
        }

        if (request.method === 'GET') {
            try {
                const data = await StockAnalysisService.getLatestStockAnalysis(symbol, env);
                if (!data) {
                    return createResponse(404, `暂无 ${symbol} 的分析记录`);
                }
                return createResponse(200, 'success', data);
            } catch (error: any) {
                return createResponse(500, error instanceof Error ? error.message : 'Internal Server Error');
            }
        }

        return createResponse(405, 'Method Not Allowed - 仅支持 GET/POST');
    }
}
