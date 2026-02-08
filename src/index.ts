import { ProfitForecastController } from './controllers/ProfitForecastController';
import { StockInfoController } from './controllers/StockInfoController';
import { createResponse } from './utils/response';
import { isValidAShareSymbol } from './utils/validator';

/**
 * Cloudflare Worker 入口
 *
 * 分层架构:
 * - index.ts        路由分发
 * - controllers/    请求参数校验 & 响应组装
 * - services/       核心业务逻辑（数据源请求）
 * - utils/          通用工具（响应、校验、解析、日期）
 */

export interface Env {
    AISTOCK: KVNamespace;
}

/** 路由表: [路径前缀, 处理函数] */
type RouteHandler = (symbol: string, env: Env, ctx: ExecutionContext) => Promise<Response>;

const routes: [string, RouteHandler][] = [
    ['/api/cn/stock/profit-forecast/', ProfitForecastController.getThsForecast.bind(ProfitForecastController)],
    ['/api/cn/stock/info/', StockInfoController.getStockInfo.bind(StockInfoController)],
];

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        if (request.method !== 'GET') {
            return createResponse(405, 'Method Not Allowed');
        }

        try {
            const { pathname } = new URL(request.url);

            for (const [prefix, handler] of routes) {
                if (pathname.startsWith(prefix)) {
                    const symbol = pathname.slice(prefix.length).replace(/\/+$/, '');
                    if (!symbol) {
                        return createResponse(400, '缺少 symbol 参数');
                    }
                    if (!isValidAShareSymbol(symbol)) {
                        return createResponse(400, 'Invalid symbol - A股代码必须是6位数字');
                    }
                    return await handler(symbol, env, ctx);
                }
            }

            return createResponse(404, 'Not Found - 可用接口: /api/cn/stock/info/:symbol, /api/cn/stock/profit-forecast/:symbol');
        } catch (err: any) {
            return createResponse(500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    },
};