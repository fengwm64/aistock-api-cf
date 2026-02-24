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
import { EmService } from './services/EmInfoService';
import { EmStockRankService } from './services/EmStockRankService';
import { StockAnalysisService } from './services/StockAnalysisService';
import {
    HOT_STOCK_INFO_WARMUP_TOPN,
    HOT_STOCKS_CACHE_KEY,
    HOT_STOCKS_CACHE_TTL_SECONDS,
    STOCK_INFO_CACHE_TTL_SECONDS,
    HOT_STOCKS_SOURCE,
    buildStockInfoCacheKey,
    buildTimestampedCachePayload,
    type HotStocksCachePayload,
    isValidStockInfoCachePayload,
    resolveCronHotTopN,
} from './constants/cache';
import { createResponse } from './utils/response';
import { isValidAShareSymbol } from './utils/validator';
import { isAShareTradingTime } from './utils/tradingTime';

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
    CRON_HOT_TOPN?: string;
    CRON_ANALYSIS_CONCURRENCY?: string;
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

interface ReadmeDocChapter {
    id: string;
    title: string;
    content: string[];
    items?: string[];
}

const README_DOC_CHAPTERS: ReadmeDocChapter[] = [
    {
        id: 'overview',
        title: '项目简介',
        content: [
            'AIStock API 基于 Cloudflare Workers，提供 A 股列表、股票信息、行情、指数、新闻、盈利预测、板块龙头、个股 AI 评价和 OCR 等能力。',
        ],
    },
    {
        id: 'architecture',
        title: '架构',
        content: [
            'README 的架构章节说明了分层设计：路由层负责 URL 匹配，控制器层负责参数校验和响应组装，服务层负责外部数据源请求，工具层提供通用能力。',
            '技术栈包含 Cloudflare Workers、TypeScript、D1（含读复制）、Workers KV 与 cheerio。',
        ],
    },
    {
        id: 'api',
        title: 'API 接口章节',
        content: [
            'README 将 API 按能力划分为以下章节，可用于快速定位接口说明与请求示例。',
        ],
        items: [
            '1. A股列表查询',
            '2. 股票基本信息',
            '3. 实时行情（核心行情 / 盘口活跃度 / K线）',
            '4. 股票基本面',
            '5. 盈利预测（列表 / 搜索 / 单股）',
            '6. 指数实时行情（含全球指数）',
            '7. 热门人气榜（含板块龙头）',
            '8. 新闻头条与个股新闻（含 AI 评价与历史记录）',
            '9. 新闻详情',
            '10. 微信网页授权登录（含扫码登录与用户设置）',
        ],
    },
    {
        id: 'cron',
        title: '定时任务与缓存',
        content: [
            'README 说明了热榜缓存刷新、热门股信息预热和自选股 AI 分析刷新三类 Cron 任务，并解释了 KV 缓存与接口请求之间的协作关系。',
        ],
    },
    {
        id: 'errors',
        title: '错误响应',
        content: [
            '错误响应统一为 JSON 结构：code、message、data，便于前后端一致处理。',
        ],
    },
    {
        id: 'changelog',
        title: '更新日志',
        content: [
            'README 按日期记录了近期变更，包括 2026-02-19、2026-02-17、2026-02-12、2026-02-11、2026-02-10、2026-02-09 等版本更新。',
        ],
    },
    {
        id: 'database',
        title: '数据库配置',
        content: [
            'README 给出了 D1 初始化、建表与索引脚本执行方式，以及相关 Cloudflare 配置建议。',
        ],
    },
    {
        id: 'development',
        title: '开发',
        content: [
            'README 提供了安装依赖、本地开发、类型检查与部署的命令示例。',
        ],
    },
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

const HOT_STOCKS_CRON_EXPRESSION = '*/30 * * * *';
const HOT_STOCK_INFO_WARMUP_CRON_EXPRESSION = '*/5 * * * *';
const HOT_STOCK_INFO_WARMUP_CONCURRENCY = 6;
const FAVORITES_ANALYSIS_REFRESH_CRON_EXPRESSIONS = new Set([
    '30 1 * * 1-5', // UTC -> 北京时间 09:30
    '0 5 * * 1-5',  // UTC -> 北京时间 13:00
    '0 7 * * 1-5',  // UTC -> 北京时间 15:00
]);
const DEFAULT_ANALYSIS_REFRESH_CONCURRENCY = 2;
const MAX_ANALYSIS_REFRESH_CONCURRENCY = 6;

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function createDocResponse(): Response {
    const navHtml = README_DOC_CHAPTERS
        .map(chapter => `<a href="#${escapeHtml(chapter.id)}">${escapeHtml(chapter.title)}</a>`)
        .join('');

    const sectionsHtml = README_DOC_CHAPTERS
        .map((chapter) => {
            const contentHtml = chapter.content
                .map(paragraph => `<p>${escapeHtml(paragraph)}</p>`)
                .join('');
            const itemHtml = chapter.items && chapter.items.length > 0
                ? `<ul>${chapter.items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
                : '';

            return `
                <section id="${escapeHtml(chapter.id)}">
                    <h2>${escapeHtml(chapter.title)}</h2>
                    ${contentHtml}
                    ${itemHtml}
                </section>
            `;
        })
        .join('');

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
        nav {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin: 0 0 22px;
        }
        nav a {
            text-decoration: none;
            color: var(--accent);
            padding: 6px 12px;
            border: 1px solid var(--line);
            border-radius: 999px;
            background: #fffef7;
            font-size: 14px;
        }
        main {
            display: grid;
            gap: 14px;
        }
        section {
            border: 1px solid var(--line);
            border-radius: 16px;
            background: var(--card);
            padding: 18px 16px;
            box-shadow: 0 8px 20px rgba(22, 28, 45, 0.06);
        }
        h2 {
            margin: 0 0 8px;
            font-size: 20px;
        }
        p {
            margin: 0 0 8px;
            color: var(--muted);
        }
        ul {
            margin: 4px 0 0 20px;
            padding: 0;
            color: var(--muted);
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
        <h1>AIStock API 文档</h1>
        <p class="lead">此页面展示 README 主要章节，完整内容请查看仓库根目录 README.md。</p>
        <nav>${navHtml}</nav>
        <main>${sectionsHtml}</main>
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

function resolveAnalysisRefreshConcurrency(raw: string | undefined): number {
    const parsed = Number(String(raw ?? '').trim());
    if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_ANALYSIS_REFRESH_CONCURRENCY;
    return Math.min(parsed, MAX_ANALYSIS_REFRESH_CONCURRENCY);
}

async function refreshHotStocksCache(env: Env): Promise<void> {
    if (!env.KV) {
        console.warn('[Cron][HotStocks] KV binding is missing, skip refresh');
        return;
    }

    const topN = resolveCronHotTopN(env.CRON_HOT_TOPN);
    const rankList = await EmStockRankService.getStockHotRank();
    const hotStocks = rankList.slice(0, topN);
    const payload: HotStocksCachePayload = {
        timestamp: Date.now(),
        generatedAt: new Date().toISOString(),
        source: HOT_STOCKS_SOURCE,
        topN: hotStocks.length,
        symbols: hotStocks.map(item => item['股票代码']),
        hotStocks,
    };

    await env.KV.put(HOT_STOCKS_CACHE_KEY, JSON.stringify(payload), {
        expirationTtl: HOT_STOCKS_CACHE_TTL_SECONDS,
    });

    console.log(`[Cron][HotStocks] refreshed ${HOT_STOCKS_CACHE_KEY}, topN=${payload.topN}`);
}

async function warmupHotStockInfos(env: Env): Promise<void> {
    if (!env.KV) {
        console.warn('[Cron][HotStockInfoWarmup] KV binding is missing, skip warmup');
        return;
    }

    let hotStocksPayload: HotStocksCachePayload | null = null;
    try {
        hotStocksPayload = await env.KV.get<HotStocksCachePayload>(HOT_STOCKS_CACHE_KEY, 'json');
    } catch (err) {
        console.error('[Cron][HotStockInfoWarmup] failed to read hot stocks cache:', err);
    }

    const symbolsFromRank = hotStocksPayload && Array.isArray(hotStocksPayload.hotStocks)
        ? hotStocksPayload.hotStocks.map(item => item?.['股票代码'])
        : [];
    const symbolsFromField = hotStocksPayload && Array.isArray(hotStocksPayload.symbols)
        ? hotStocksPayload.symbols
        : [];
    const hotSymbols = Array.from(
        new Set(
            (symbolsFromRank.length > 0 ? symbolsFromRank : symbolsFromField)
                .filter((item): item is string => typeof item === 'string')
                .map(item => item.trim())
                .filter(isValidAShareSymbol),
        ),
    ).slice(0, HOT_STOCK_INFO_WARMUP_TOPN);

    let favoriteSymbols: string[] = [];
    try {
        const queryResult = await env.DB
            .prepare(
                `SELECT DISTINCT symbol
                 FROM user_stocks
                 ORDER BY symbol ASC`,
            )
            .all<{ symbol: string }>();

        favoriteSymbols = Array.from(
            new Set(
                (queryResult.results || [])
                    .map(row => String(row.symbol || '').trim())
                    .filter(isValidAShareSymbol),
            ),
        );
    } catch (err) {
        console.error('[Cron][HotStockInfoWarmup] failed to read favorite symbols:', err);
    }

    const symbols = Array.from(new Set([...hotSymbols, ...favoriteSymbols]));
    if (symbols.length === 0) {
        console.log('[Cron][HotStockInfoWarmup] no symbols from hot list and favorites, skip');
        return;
    }

    const queue = symbols.slice();
    let hitCount = 0;
    let filledCount = 0;
    let failedCount = 0;

    const workers = Array.from(
        { length: Math.min(HOT_STOCK_INFO_WARMUP_CONCURRENCY, queue.length) },
        async () => {
            while (queue.length > 0) {
                const symbol = queue.shift();
                if (!symbol) break;

                const cacheKey = buildStockInfoCacheKey(symbol);
                try {
                    const cached = await env.KV.get(cacheKey, 'json');
                    if (isValidStockInfoCachePayload(cached)) {
                        hitCount++;
                        continue;
                    }
                } catch (err) {
                    console.error(`[Cron][HotStockInfoWarmup] failed to read ${cacheKey}:`, err);
                }

                try {
                    const data = await EmService.getStockInfo(symbol);
                    if (Object.keys(data).length > 0) {
                        await env.KV.put(cacheKey, JSON.stringify(buildTimestampedCachePayload(data)), {
                            expirationTtl: STOCK_INFO_CACHE_TTL_SECONDS,
                        });
                    }
                    filledCount++;
                } catch (err) {
                    failedCount++;
                    console.error(`[Cron][HotStockInfoWarmup] failed to warmup ${cacheKey}:`, err);
                }
            }
        },
    );

    await Promise.all(workers);

    console.log(
        `[Cron][HotStockInfoWarmup] checked=${symbols.length}, hot=${hotSymbols.length}, favorites=${favoriteSymbols.length}, hit=${hitCount}, filled=${filledCount}, failed=${failedCount}`,
    );
}

async function refreshFavoritesStockAnalysis(env: Env): Promise<void> {
    const inTradingTime = await isAShareTradingTime();
    if (!inTradingTime) {
        console.log('[Cron][FavoritesAnalysis] skip: not in A-share trading time');
        return;
    }

    const queryResult = await env.DB
        .prepare(
            `SELECT DISTINCT symbol
             FROM user_stocks
             ORDER BY symbol ASC`,
        )
        .all<{ symbol: string }>();

    const symbols = Array.from(
        new Set(
            (queryResult.results || [])
                .map(row => String(row.symbol || '').trim())
                .filter(isValidAShareSymbol),
        ),
    );

    if (symbols.length === 0) {
        console.log('[Cron][FavoritesAnalysis] skip: no favorite symbols');
        return;
    }

    const concurrency = resolveAnalysisRefreshConcurrency(env.CRON_ANALYSIS_CONCURRENCY);
    const queue = symbols.slice();
    let success = 0;
    let failed = 0;

    console.log(
        `[Cron][FavoritesAnalysis] start: symbols=${symbols.length}, concurrency=${concurrency}`,
    );

    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length > 0) {
            const symbol = queue.shift();
            if (!symbol) break;

            try {
                await StockAnalysisService.createStockAnalysis(symbol, env);
                success++;
            } catch (err) {
                failed++;
                console.error(`[Cron][FavoritesAnalysis] failed for ${symbol}:`, err);
            }
        }
    });

    await Promise.all(workers);

    console.log(
        `[Cron][FavoritesAnalysis] done: total=${symbols.length}, success=${success}, failed=${failed}`,
    );
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
    },
    async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
        if (event.cron === HOT_STOCKS_CRON_EXPRESSION) {
            ctx.waitUntil((async () => {
                try {
                    await refreshHotStocksCache(env);
                } catch (err) {
                    console.error('[Cron][HotStocks] refresh failed:', err);
                }
            })());
            return;
        }

        if (event.cron === HOT_STOCK_INFO_WARMUP_CRON_EXPRESSION) {
            ctx.waitUntil((async () => {
                try {
                    await warmupHotStockInfos(env);
                } catch (err) {
                    console.error('[Cron][HotStockInfoWarmup] failed:', err);
                }
            })());
            return;
        }

        if (FAVORITES_ANALYSIS_REFRESH_CRON_EXPRESSIONS.has(event.cron)) {
            ctx.waitUntil((async () => {
                try {
                    await refreshFavoritesStockAnalysis(env);
                } catch (err) {
                    console.error('[Cron][FavoritesAnalysis] failed:', err);
                }
            })());
            return;
        }

        console.log(`[Cron] Unhandled expression: ${event.cron}`);
    },
};
