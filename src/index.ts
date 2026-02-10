import { ProfitForecastController } from './controllers/ProfitForecastController';
import { StockInfoController } from './controllers/StockInfoController';
import { StockQuoteController } from './controllers/StockQuoteController';
import { StockRankController } from './controllers/StockRankController';
import { StockListController } from './controllers/StockListController';
import { IndexQuoteController } from './controllers/IndexQuoteController';
import { NewsController } from './controllers/NewsController';
import { AuthController } from './controllers/AuthController';
import { UserController } from './controllers/UserController';
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
    KV: KVNamespace;
    DB: D1Database;
    WECHAT_APPID: string;
    WECHAT_SECRET: string;
    JWT_SECRET: string;
    FRONTEND_URL: string;
    COOKIE_DOMAIN: string;
    CORS_ALLOW_ORIGIN: string;
}

/** 带 symbol 参数的路由 */
type SymbolRouteHandler = (symbol: string, env: Env, ctx: ExecutionContext) => Promise<Response>;

/** 带数字 ID 参数的路由 */
type IdRouteHandler = (id: string, env: Env, ctx: ExecutionContext) => Promise<Response>;

/** 无参数的路由 */
type SimpleRouteHandler = (env: Env, ctx: ExecutionContext) => Promise<Response>;

/** 带查询参数的路由 */
type QueryRouteHandler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

const symbolRoutes: [string, SymbolRouteHandler][] = [
    ['/api/cn/stock/profit-forecast/', ProfitForecastController.getThsForecast.bind(ProfitForecastController)],
];

const idRoutes: [string, IdRouteHandler][] = [
    ['/api/news/', NewsController.getNewsDetail.bind(NewsController)],
];

const simpleRoutes: [string, SimpleRouteHandler][] = [
    ['/api/news/headlines', NewsController.getHeadlines.bind(NewsController)],
    ['/api/news/cn', NewsController.getCnNews.bind(NewsController)],
    ['/api/news/hk', NewsController.getHkNews.bind(NewsController)],
    ['/api/news/gb', NewsController.getGlobalNews.bind(NewsController)],
    ['/api/news/fund', NewsController.getFundNews.bind(NewsController)],
];

const queryRoutes: [string, QueryRouteHandler][] = [
    ['/api/auth/wechat/login', AuthController.login.bind(AuthController)],
    ['/api/auth/wechat/callback', AuthController.callback.bind(AuthController)],
    ['/api/auth/logout', AuthController.logout.bind(AuthController)],
    ['/api/users/me', UserController.me.bind(UserController)],
    ['/api/users/me/favorites', UserController.addFavorites.bind(UserController)],
    ['/api/users/me/favorites/delete', UserController.removeFavorites.bind(UserController)],
    ['/api/cn/market/stockrank', StockRankController.getHotRank.bind(StockRankController)],
    ['/api/cn/stocks', StockListController.getStockList.bind(StockListController)],
    ['/api/cn/stock/infos', StockInfoController.getBatchStockInfo.bind(StockInfoController)],
    ['/api/cn/stock/quotes/core', StockQuoteController.getCoreQuotes.bind(StockQuoteController)],
    ['/api/cn/stock/quotes/activity', StockQuoteController.getActivityQuotes.bind(StockQuoteController)],
    ['/api/cn/stock/fundamentals', StockQuoteController.getFundamentalQuotes.bind(StockQuoteController)],
    ['/api/cn/index/quotes', IndexQuoteController.getIndexQuotes.bind(IndexQuoteController)],
    ['/api/gb/index/quotes', IndexQuoteController.getGlobalIndexQuotes.bind(IndexQuoteController)],
];

function getCorsOrigin(request: Request, env: Env): string | null {
    if (env.CORS_ALLOW_ORIGIN) return env.CORS_ALLOW_ORIGIN;
    if (env.FRONTEND_URL) {
        try {
            return new URL(env.FRONTEND_URL).origin;
        } catch {
            return request.headers.get('Origin');
        }
    }
    return request.headers.get('Origin');
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const allowedMethods = ['GET', 'POST', 'DELETE', 'OPTIONS'];

        if (request.method === 'OPTIONS') {
            const origin = getCorsOrigin(request, env);
            const headers = new Headers();
            if (origin) headers.set('Access-Control-Allow-Origin', origin);
            headers.set('Access-Control-Allow-Credentials', 'true');
            headers.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
            headers.set('Access-Control-Allow-Headers', request.headers.get('Access-Control-Request-Headers') || 'Content-Type');
            headers.set('Access-Control-Max-Age', '86400');
            headers.set('Vary', 'Origin');
            return new Response(null, { status: 204, headers });
        }

        if (!allowedMethods.includes(request.method)) {
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

            // 带数字 ID 参数路由
            for (const [prefix, handler] of idRoutes) {
                if (pathname.startsWith(prefix)) {
                    const id = pathname.slice(prefix.length).replace(/\/+$/, '');
                    if (!id) {
                        return createResponse(400, '缺少 ID 参数');
                    }
                    if (!/^\d+$/.test(id)) {
                        return createResponse(400, 'Invalid ID - ID 必须是数字');
                    }
                    return await handler(id, env, ctx);
                }
            }

            return createResponse(404, 'Not Found - 可用接口: /api/auth/wechat/login, /api/auth/wechat/callback, /api/auth/logout, /api/users/me, /api/users/me/favorites, /api/users/me/favorites/delete, /api/cn/stocks, /api/cn/stock/infos, /api/cn/stock/quotes/core, /api/cn/stock/quotes/activity, /api/cn/stock/fundamentals, /api/cn/stock/profit-forecast/:symbol, /api/cn/market/stockrank, /api/cn/index/quotes, /api/gb/index/quotes, /api/news/headlines, /api/news/cn, /api/news/hk, /api/news/gb, /api/news/fund, /api/news/:id');
        } catch (err: any) {
            return createResponse(500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    },
};