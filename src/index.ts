import { ProfitForecastController } from './controllers/ProfitForecastController';
import { StockInfoController } from './controllers/StockInfoController';
import { StockQuoteController } from './controllers/StockQuoteController';
import { StockRankController } from './controllers/StockRankController';
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

/** 带 symbol 参数的路由 */
type SymbolRouteHandler = (symbol: string, env: Env, ctx: ExecutionContext) => Promise<Response>;

/** 无参数的路由 */
type SimpleRouteHandler = (env: Env, ctx: ExecutionContext) => Promise<Response>;

/** 带查询参数的路由 */
type QueryRouteHandler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

const symbolRoutes: [string, SymbolRouteHandler][] = [
    ['/api/cn/stock/profit-forecast/', ProfitForecastController.getThsForecast.bind(ProfitForecastController)],
    ['/api/cn/stock/info/', StockInfoController.getStockInfo.bind(StockInfoController)],
];

const simpleRoutes: [string, SimpleRouteHandler][] = [
    ['/api/cn/market/stockrank/', StockRankController.getHotRank.bind(StockRankController)],
];

const queryRoutes: [string, QueryRouteHandler][] = [
    ['/api/cn/stock/quotes/core', StockQuoteController.getCoreQuotes.bind(StockQuoteController)],
    ['/api/cn/stock/quotes/activity', StockQuoteController.getActivityQuotes.bind(StockQuoteController)],
    ['/api/cn/stock/quotes/fundamental', StockQuoteController.getFundamentalQuotes.bind(StockQuoteController)],
];

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        if (request.method !== 'GET') {
            return createResponse(405, 'Method Not Allowed');
        }

        try {
            const url = new URL(request.url);
            const { pathname } = url;

            // 无参数路由
            for (const [prefix, handler] of simpleRoutes) {
                if (pathname === prefix || pathname === prefix.slice(0, -1)) {
                    return await handler(env, ctx);
                }
            }

            // 带查询参数路由
            for (const [path, handler] of queryRoutes) {
                if (pathname === path || pathname === path + '/') {
                    return await handler(request, env, ctx);
                }
            }

            // 带 symbol 参数路由
            for (const [prefix, handler] of symbolRoutes) {
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

            return createResponse(404, 'Not Found - 可用接口: /api/cn/stock/info/:symbol, /api/cn/stock/quotes/core, /api/cn/stock/quotes/activity, /api/cn/stock/quotes/fundamental, /api/cn/stock/profit-forecast/:symbol, /api/cn/market/stockrank/');
        } catch (err: any) {
            return createResponse(500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    },
};