import { ProfitForecastController } from './controllers/ProfitForecastController';
import { StockInfoController } from './controllers/StockInfoController';
import { StockQuoteController } from './controllers/StockQuoteController';
import { StockRankController } from './controllers/StockRankController';
import { StockListController } from './controllers/StockListController';
import { IndexQuoteController } from './controllers/IndexQuoteController';
import { TagLeaderController } from './controllers/TagLeaderController';
import { NewsController } from './controllers/NewsController';
import { AuthController } from './controllers/AuthController';
import { UserController } from './controllers/UserController';
import { WechatEventController } from './controllers/WechatEventController';
import { ScanLoginController } from './controllers/ScanLoginController';
import { StockAnalysisController } from './controllers/StockAnalysisController';
import { StockOcrController } from './controllers/StockOcrController';
import { readFileSync } from 'node:fs';
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
    WECHAT_TOKEN: string;
    FRONTEND_URL: string;
    COOKIE_DOMAIN: string;
    CORS_ALLOW_ORIGIN: string;
    OPENAI_API_BASE_URL: string;
    OPENAI_API_KEY: string;
    EVA_MODEL: string;
    OCR_MODEL: string;
}

/** 带数字 ID 参数的路由 */
type IdRouteHandler = (id: string, env: Env, ctx: ExecutionContext) => Promise<Response>;

/** 无参数的路由 */
type SimpleRouteHandler = (env: Env, ctx: ExecutionContext) => Promise<Response>;

/** 带查询参数的路由 */
type QueryRouteHandler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
/** 路径中携带 symbol，且带查询参数的路由 */
type SymbolQueryRouteHandler = (symbol: string, request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
/** 路径中携带 tagCode，且带查询参数的路由 */
type TagQueryRouteHandler = (tagCode: string, request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
/** 路径中携带 settingType，且带查询参数的路由 */
type SettingQueryRouteHandler = (settingType: string, request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

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
    ['/api/auth/wechat/push', WechatEventController.handle.bind(WechatEventController)],
    ['/api/auth/wechat/login/scan', ScanLoginController.generateQrCode.bind(ScanLoginController)],
    ['/api/auth/wechat/login/scan/poll', ScanLoginController.poll.bind(ScanLoginController)],
    ['/api/auth/logout', AuthController.logout.bind(AuthController)],
    ['/api/users/me', UserController.me.bind(UserController)],
    ['/api/users/me/settings', UserController.getSettings.bind(UserController)],
    ['/api/users/me/news/push', UserController.getPushNews.bind(UserController)],
    ['/api/users/me/favorites', UserController.addFavorites.bind(UserController)],
    ['/api/users/me/favorites/delete', UserController.removeFavorites.bind(UserController)],
    ['/api/cn/market/stockrank', StockRankController.getHotRank.bind(StockRankController)],
    ['/api/cn/stocks', StockListController.getStockList.bind(StockListController)],
    ['/api/cn/stock/infos', StockInfoController.getBatchStockInfo.bind(StockInfoController)],
    ['/api/cn/stock/quotes/core', StockQuoteController.getCoreQuotes.bind(StockQuoteController)],
    ['/api/cn/stock/quotes/activity', StockQuoteController.getActivityQuotes.bind(StockQuoteController)],
    ['/api/cn/stock/quotes/kline', StockQuoteController.getKLine.bind(StockQuoteController)],
    ['/api/cn/stock/fundamentals', StockQuoteController.getFundamentalQuotes.bind(StockQuoteController)],
    ['/api/cn/stocks/profit-forecast', ProfitForecastController.getForecastList.bind(ProfitForecastController)],
    ['/api/cn/stocks/profit-forecast/search', ProfitForecastController.searchForecastList.bind(ProfitForecastController)],
    ['/api/cn/stocks/ocr', StockOcrController.batchOcr.bind(StockOcrController)],
    ['/api/cn/index/quotes', IndexQuoteController.getIndexQuotes.bind(IndexQuoteController)],
    ['/api/gb/index/quotes', IndexQuoteController.getGlobalIndexQuotes.bind(IndexQuoteController)],
];

const symbolQueryRoutes: [RegExp, SymbolQueryRouteHandler][] = [
    [/^\/api\/cn\/stocks\/([0-9]{6})\/news\/?$/, NewsController.getStockNews.bind(NewsController)],
    [/^\/api\/cn\/stocks\/([0-9]{6})\/analysis\/history\/?$/, StockAnalysisController.getStockAnalysisHistory.bind(StockAnalysisController)],
    [/^\/api\/cn\/stocks\/([0-9]{6})\/analysis\/?$/, StockAnalysisController.handleStockAnalysis.bind(StockAnalysisController)],
    [/^\/api\/cn\/stock\/([0-9]{6})\/profit-forecast\/?$/, ProfitForecastController.getThsForecast.bind(ProfitForecastController)],
];

const tagQueryRoutes: [RegExp, TagQueryRouteHandler][] = [
    [/^\/api\/cn\/tags\/([^/]+)\/leaders\/?$/, TagLeaderController.getTagLeaders.bind(TagLeaderController)],
];

const settingQueryRoutes: [RegExp, SettingQueryRouteHandler][] = [
    [/^\/api\/users\/me\/settings\/([^/]+)\/?$/, UserController.updateSetting.bind(UserController)],
];

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function readReadmeContent(): string {
    try {
        return readFileSync('/bundle/README.md', 'utf8');
    } catch (err) {
        console.error('[Doc] failed to read /bundle/README.md:', err);
        return 'README.md not found in worker bundle.';
    }
}

function createDocResponse(): Response {
    const readmeHtml = escapeHtml(readReadmeContent());

    const html = `<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>AIStock API 文档</title>
    <style>
        :root {
            --bg: #f8f9ef;
            --card: #ffffff;
            --text: #0f172a;
            --muted: #334155;
            --line: #d4d4aa;
            --accent: #1f6f78;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            color: var(--text);
            font: 16px/1.7 "SF Pro Text","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
            background:
                radial-gradient(1200px 800px at 0% 0%, #eef7eb 0%, transparent 65%),
                radial-gradient(1000px 700px at 100% 0%, #e6f1ff 0%, transparent 60%),
                var(--bg);
        }
        .container {
            max-width: 980px;
            margin: 0 auto;
            padding: 28px 18px 56px;
        }
        h1 {
            margin: 0 0 8px;
            font-size: clamp(28px, 4vw, 40px);
            line-height: 1.2;
            letter-spacing: -0.02em;
        }
        .lead {
            margin: 0 0 16px;
            color: var(--muted);
        }
        .doc {
            border: 1px solid var(--line);
            border-radius: 16px;
            background: var(--card);
            padding: 16px;
            box-shadow: 0 8px 20px rgba(22, 28, 45, 0.06);
            overflow-x: auto;
        }
        pre {
            margin: 0;
            color: var(--muted);
            font: 14px/1.55 Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
            white-space: pre;
        }
        footer {
            margin-top: 24px;
            font-size: 13px;
            color: var(--muted);
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>README 原文</h1>
        <p class="lead">以下内容为仓库根目录 README.md 的完整原文。</p>
        <div class="doc"><pre>${readmeHtml}</pre></div>
        <footer>健康检查：<code>/</code> | 文档：<code>/doc</code></footer>
    </div>
</body>
</html>`;

    return new Response(html, {
        status: 200,
        headers: {
            'Content-Type': 'text/html;charset=UTF-8',
            'Cache-Control': 'no-store',
        },
    });
}

function getCorsOrigin(request: Request, env: Env): string | null {
    if (env.CORS_ALLOW_ORIGIN && env.CORS_ALLOW_ORIGIN !== '*') return env.CORS_ALLOW_ORIGIN;
    if (env.FRONTEND_URL) {
        try {
            return new URL(env.FRONTEND_URL).origin;
        } catch {
            return request.headers.get('Origin');
        }
    }
    return request.headers.get('Origin');
}

function withCors(response: Response, request: Request, env: Env): Response {
    const origin = getCorsOrigin(request, env);
    if (!origin) return response;
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Vary', 'Origin');
    return new Response(response.body, { status: response.status, headers });
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const allowedMethods = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];

        if (request.method === 'OPTIONS') {
            const origin = getCorsOrigin(request, env);
            const headers = new Headers();
            if (origin) headers.set('Access-Control-Allow-Origin', origin);
            headers.set('Access-Control-Allow-Credentials', 'true');
            headers.set('Access-Control-Allow-Methods', allowedMethods.join(','));
            headers.set('Access-Control-Allow-Headers', request.headers.get('Access-Control-Request-Headers') || 'Content-Type');
            headers.set('Access-Control-Max-Age', '86400');
            headers.set('Vary', 'Origin');
            return new Response(null, { status: 204, headers });
        }

        if (!allowedMethods.includes(request.method)) {
            return withCors(createResponse(405, 'Method Not Allowed'), request, env);
        }

        try {
            const url = new URL(request.url);
            const { pathname } = url;

            if (pathname === '/' || pathname === '') {
                return withCors(
                    createResponse(200, 'healthy', {
                        status: 'ok',
                        service: 'aistock-api-cf',
                        timestamp: new Date().toISOString(),
                        docs: '/doc',
                    }),
                    request,
                    env,
                );
            }

            if (pathname === '/doc' || pathname === '/doc/') {
                return withCors(createDocResponse(), request, env);
            }

            // 无参数路由
            for (const [prefix, handler] of simpleRoutes) {
                if (pathname === prefix || pathname === prefix.slice(0, -1)) {
                    return withCors(await handler(env, ctx), request, env);
                }
            }

            // 带查询参数路由
            for (const [path, handler] of queryRoutes) {
                if (pathname === path || pathname === path + '/') {
                    return withCors(await handler(request, env, ctx), request, env);
                }
            }

            // 路径中携带 symbol 且带查询参数的路由
            for (const [pattern, handler] of symbolQueryRoutes) {
                const match = pathname.match(pattern);
                if (match && match[1]) {
                    const symbol = match[1];
                    if (!isValidAShareSymbol(symbol)) {
                        return withCors(createResponse(400, 'Invalid symbol - A股代码必须是6位数字'), request, env);
                    }
                    return withCors(await handler(symbol, request, env, ctx), request, env);
                }
            }

            // 路径中携带 tagCode 且带查询参数的路由
            for (const [pattern, handler] of tagQueryRoutes) {
                const match = pathname.match(pattern);
                if (match && match[1]) {
                    const tagCode = match[1];
                    return withCors(await handler(tagCode, request, env, ctx), request, env);
                }
            }

            // 路径中携带 settingType 且带查询参数的路由
            for (const [pattern, handler] of settingQueryRoutes) {
                const match = pathname.match(pattern);
                if (match && match[1]) {
                    const settingType = decodeURIComponent(match[1]);
                    return withCors(await handler(settingType, request, env, ctx), request, env);
                }
            }

            // 带数字 ID 参数路由
            for (const [prefix, handler] of idRoutes) {
                if (pathname.startsWith(prefix)) {
                    const id = pathname.slice(prefix.length).replace(/\/+$/, '');
                    if (!id) {
                        return withCors(createResponse(400, '缺少 ID 参数'), request, env);
                    }
                    if (!/^\d+$/.test(id)) {
                        return withCors(createResponse(400, 'Invalid ID - ID 必须是数字'), request, env);
                    }
                    return withCors(await handler(id, env, ctx), request, env);
                }
            }

            return withCors(createResponse(404, 'Not Found - 可用接口: /api/auth/wechat/login, /api/auth/wechat/login/scan, /api/auth/wechat/login/scan/poll, /api/auth/wechat/callback, /api/auth/wechat/push, /api/auth/logout, /api/users/me, /api/users/me/settings, /api/users/me/settings/:settingType, /api/users/me/news/push, /api/users/me/favorites, /api/users/me/favorites/delete, /api/cn/stocks, /api/cn/stocks/profit-forecast, /api/cn/stocks/profit-forecast/search, /api/cn/stocks/ocr, /api/cn/stocks/:symbol/news, /api/cn/stocks/:symbol/analysis, /api/cn/stocks/:symbol/analysis/history, /api/cn/stock/:symbol/profit-forecast, /api/cn/stock/infos, /api/cn/stock/quotes/core, /api/cn/stock/quotes/activity, /api/cn/stock/quotes/kline, /api/cn/stock/fundamentals, /api/cn/market/stockrank, /api/cn/tags/:tagCode/leaders, /api/cn/index/quotes, /api/gb/index/quotes, /api/news/headlines, /api/news/cn, /api/news/hk, /api/news/gb, /api/news/fund, /api/news/:id'), request, env);
        } catch (err: any) {
            return withCors(createResponse(500, err instanceof Error ? err.message : 'Internal Server Error'), request, env);
        }
    }
};
