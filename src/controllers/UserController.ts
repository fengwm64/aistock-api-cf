import { createResponse } from '../utils/response';
import { verifyJwt } from '../utils/jwt';
import { isValidAShareSymbol } from '../utils/validator';
import type { Env } from '../index';

/**
 * 用户相关接口（自选股管理）
 */
export class UserController {
    private static log(stage: string, message: string, data?: any): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[User][${stage}] ${ts} ${message}${detail}`);
    }

    private static async requireAuth(request: Request, env: Env): Promise<{ ok: true; openid: string } | { ok: false; code: number; message: string }> {
        const cookie = request.headers.get('Cookie') || '';
        const tokenMatch = cookie.match(/(?:^|;\s*)token=([^;]+)/);
        if (!tokenMatch) return { ok: false, code: 401, message: '未登录' };
        const token = tokenMatch[1];
        const payload = await verifyJwt(token, env.JWT_SECRET);
        if (!payload) return { ok: false, code: 401, message: 'token 无效或已过期' };
        return { ok: true, openid: payload.openid };
    }

    private static async extractSymbols(request: Request, allowQuery = true): Promise<string[]> {
        if (request.headers.get('Content-Type')?.includes('application/json')) {
            try {
                const body = await request.json();
                const symbols = (body as any)?.symbols;
                if (Array.isArray(symbols)) {
                    return symbols.map((s: any) => String(s).trim()).filter(Boolean);
                }
            } catch {
                // ignore
            }
        }
        if (allowQuery) {
            const url = new URL(request.url);
            const qp = url.searchParams.get('symbols') || url.searchParams.get('symbol');
            if (qp) return qp.split(',').map(s => s.trim()).filter(Boolean);
        }
        return [];
    }

    private static async buildFavoritesResponse(openid: string, env: Env): Promise<Response> {
        const user = await env.DB
            .prepare('SELECT openid, nickname, avatar_url, created_at FROM users WHERE openid = ?1')
            .bind(openid)
            .first();

        const { results: stocks } = await env.DB
            .prepare(
                `SELECT us.symbol, s.name, s.market, us.created_at
                 FROM user_stocks us
                 LEFT JOIN stocks s ON us.symbol = s.symbol
                 WHERE us.openid = ?1
                 ORDER BY us.created_at DESC`,
            )
            .bind(openid)
            .all();

        return createResponse(200, 'success', {
            openid: user?.openid || openid,
            nickname: user?.nickname || '',
            avatar_url: user?.avatar_url || '',
            created_at: user?.created_at || null,
            自选股: stocks.map((s: any) => ({
                股票代码: s.symbol,
                股票简称: s.name || null,
                市场代码: s.market || null,
                添加时间: s.created_at || null,
            })),
        });
    }

    /**
     * 获取当前用户信息
     * GET /api/users/me
     */
    static async me(request: Request, env: Env): Promise<Response> {
        UserController.log('me', '收到获取用户信息请求');

        const auth = await UserController.requireAuth(request, env);
        if (!auth.ok) {
            return createResponse(auth.code, auth.message);
        }
        const { openid } = auth;

        const user = await env.DB
            .prepare('SELECT openid, nickname, avatar_url, created_at FROM users WHERE openid = ?1')
            .bind(openid)
            .first();

        if (!user) {
            UserController.log('me', '❌ 用户不存在', { openid });
            return createResponse(404, '用户不存在');
        }

        const { results: stocks } = await env.DB
            .prepare(
                `SELECT us.symbol, s.name, s.market, us.created_at
                 FROM user_stocks us
                 LEFT JOIN stocks s ON us.symbol = s.symbol
                 WHERE us.openid = ?1
                 ORDER BY us.created_at DESC`,
            )
            .bind(openid)
            .all();

        UserController.log('me', '✅ 返回用户信息', { openid: user.openid, nickname: user.nickname });

        return createResponse(200, 'success', {
            openid: user.openid,
            nickname: user.nickname,
            avatar_url: user.avatar_url,
            created_at: user.created_at,
            自选股: stocks.map((s: any) => ({
                股票代码: s.symbol,
                股票简称: s.name || null,
                市场代码: s.market || null,
                添加时间: s.created_at || null,
            })),
        });
    }

    /**
     * 添加自选股（批量）
     * POST /api/users/me/favorites
     */
    static async addFavorites(request: Request, env: Env): Promise<Response> {
        UserController.log('addFavorites', '收到添加自选股请求', { method: request.method, url: request.url });

        if (request.method !== 'POST') {
            return createResponse(405, 'Method Not Allowed');
        }

        const auth = await UserController.requireAuth(request, env);
        if (!auth.ok) {
            return createResponse(auth.code, auth.message);
        }
        const { openid } = auth;

        const symbols = await UserController.extractSymbols(request);
        UserController.log('addFavorites', '解析 symbols 完成', { count: symbols.length, symbols });
        if (symbols.length === 0) {
            UserController.log('addFavorites', '❌ 缺少 symbols 参数');
            return createResponse(400, '缺少 symbols 参数');
        }

        const validSymbols = symbols.filter(isValidAShareSymbol);
        UserController.log('addFavorites', '过滤有效 symbols', { count: validSymbols.length, validSymbols });
        if (validSymbols.length === 0) {
            return createResponse(400, 'symbols 均无效，需 6 位 A 股代码');
        }

        const stmt = env.DB.prepare('INSERT OR IGNORE INTO user_stocks (openid, symbol) VALUES (?1, ?2)');
        for (const sym of validSymbols) {
            await stmt.bind(openid, sym).run();
        }

        UserController.log('addFavorites', '✅ 添加完成', { openid, count: validSymbols.length });

        return await UserController.buildFavoritesResponse(openid, env);
    }

    /**
     * 删除自选股（批量）
     * DELETE /api/users/me/favorites（Body: { symbols: [] }）
     * 兼容 POST /api/users/me/favorites/delete
     */
    static async removeFavorites(request: Request, env: Env): Promise<Response> {
        UserController.log('removeFavorites', '收到删除自选股请求', { method: request.method, url: request.url });

        const isDelete = request.method === 'DELETE';
        const isPostDelete = request.method === 'POST';
        if (!isDelete && !isPostDelete) {
            return createResponse(405, 'Method Not Allowed');
        }

        const auth = await UserController.requireAuth(request, env);
        if (!auth.ok) {
            return createResponse(auth.code, auth.message);
        }
        const { openid } = auth;

        const symbols = await UserController.extractSymbols(request, !isDelete);
        UserController.log('removeFavorites', '解析 symbols 完成', { count: symbols.length, symbols, allowQuery: !isDelete });
        if (symbols.length === 0) {
            UserController.log('removeFavorites', '❌ 缺少 symbols 参数');
            return createResponse(400, '缺少 symbols 参数');
        }

        const validSymbols = symbols.filter(isValidAShareSymbol);
        UserController.log('removeFavorites', '过滤有效 symbols', { count: validSymbols.length, validSymbols });
        if (validSymbols.length === 0) {
            return createResponse(400, 'symbols 均无效，需 6 位 A 股代码');
        }

        const stmt = env.DB.prepare('DELETE FROM user_stocks WHERE openid = ?1 AND symbol = ?2');
        for (const sym of validSymbols) {
            await stmt.bind(openid, sym).run();
        }

        UserController.log('removeFavorites', '✅ 删除完成', { openid, count: validSymbols.length });

        return await UserController.buildFavoritesResponse(openid, env);
    }

    /**
     * 获取当前用户推送新闻（占位）
     * GET /api/users/me/news/push
     */
    static async getPushNews(request: Request, env: Env): Promise<Response> {
        UserController.log('getPushNews', '收到获取用户推送新闻请求', { method: request.method, url: request.url });

        if (request.method !== 'GET') {
            return createResponse(405, 'Method Not Allowed');
        }

        const auth = await UserController.requireAuth(request, env);
        if (!auth.ok) {
            return createResponse(auth.code, auth.message);
        }

        return createResponse(200, 'success', {
            推送新闻: [],
        });
    }
}
