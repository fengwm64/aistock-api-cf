import { signJwt } from '../utils/jwt';
import { createResponse } from '../utils/response';
import type { Env } from '../index';

/**
 * 微信网页授权登录控制器
 *
 * 流程:
 *  1. GET /api/auth/wechat/login        → 302 跳转微信授权页
 *  2. GET /api/auth/wechat/callback      → code 换 token → 查/建用户 → JWT → Set-Cookie → 302 回首页
 */
export class AuthController {

    private static log(stage: string, message: string, data?: any): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[Auth][${stage}] ${ts} ${message}${detail}`);
    }

    private static getCorsOrigin(request: Request, env: Env): string | null {
        if (env.CORS_ALLOW_ORIGIN && env.CORS_ALLOW_ORIGIN !== '*') {
            return env.CORS_ALLOW_ORIGIN;
        }
        if (env.FRONTEND_URL) {
            try {
                return new URL(env.FRONTEND_URL).origin;
            } catch {
                return request.headers.get('Origin');
            }
        }
        return request.headers.get('Origin');
    }

    private static withCors(response: Response, request: Request, env: Env): Response {
        const origin = AuthController.getCorsOrigin(request, env);
        if (!origin) {
            return response;
        }
        const headers = new Headers(response.headers);
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Access-Control-Allow-Credentials', 'true');
        headers.set('Vary', 'Origin');
        return new Response(response.body, { status: response.status, headers });
    }

    /* ──────────── 1. 跳转微信授权 ──────────── */

    static async login(request: Request, env: Env): Promise<Response> {
        AuthController.log('login', '收到登录请求', { url: request.url });

        const appid = env.WECHAT_APPID;
        if (!appid) {
            AuthController.log('login', '❌ 缺少 WECHAT_APPID 环境变量');
            return createResponse(500, '服务端未配置 WECHAT_APPID');
        }

        // 回调地址: 同域 /api/auth/wechat/callback
        const url = new URL(request.url);
        const redirectUri = `${url.origin}/api/auth/wechat/callback`;

        // 可选: 前端传入 redirect 参数，登录成功后跳回指定页面
        const state = url.searchParams.get('redirect') || '/';

        const authUrl =
            'https://open.weixin.qq.com/connect/oauth2/authorize' +
            `?appid=${appid}` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&response_type=code` +
            `&scope=snsapi_userinfo` +
            `&state=${encodeURIComponent(state)}` +
            `#wechat_redirect`;

        AuthController.log('login', '302 跳转微信授权', { appid, redirectUri, state, authUrl });
        return Response.redirect(authUrl, 302);
    }

    /* ──────────── 2. 微信回调 ──────────── */

    static async callback(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state') || '/';

        AuthController.log('callback', '收到微信回调', { code: code ? `${code.slice(0, 8)}...` : null, state });

        if (!code) {
            AuthController.log('callback', '❌ 缺少 code 参数');
            return createResponse(400, '缺少 code 参数');
        }

        try {
            /* ① code 换 access_token + openid */
            AuthController.log('callback', '① 开始用 code 换取 access_token');
            const tokenData = await AuthController.exchangeCodeForToken(code, env);
            if (tokenData.errcode) {
                AuthController.log('callback', '❌ 换取 access_token 失败', { errcode: tokenData.errcode, errmsg: tokenData.errmsg });
                return createResponse(400, `微信授权失败: ${tokenData.errmsg}`);
            }

            const { access_token, openid } = tokenData;
            AuthController.log('callback', '✅ 换取 access_token 成功', { openid, scope: tokenData.scope });

            /* ② 拉取用户信息（snsapi_userinfo） */
            AuthController.log('callback', '② 开始拉取用户信息', { openid });
            const userInfo = await AuthController.fetchWechatUserInfo(access_token, openid);

            if (userInfo.errcode) {
                AuthController.log('callback', '❌ 拉取用户信息失败', { errcode: userInfo.errcode, errmsg: userInfo.errmsg });
            }

            const nickname = userInfo.nickname || '';
            const avatarUrl = userInfo.headimgurl || '';
            AuthController.log('callback', '✅ 用户信息获取成功', { openid, nickname, hasAvatar: !!avatarUrl });

            /* ③ 查询 / 新建用户（D1） */
            AuthController.log('callback', '③ 写入 D1 用户表（UPSERT）', { openid, nickname });
            await AuthController.upsertUser(env.DB, openid, nickname, avatarUrl);
            AuthController.log('callback', '✅ D1 写入成功');

            /* ④ 签发 JWT */
            const now = Math.floor(Date.now() / 1000);
            const exp = now + 7 * 24 * 3600;
            AuthController.log('callback', '④ 签发 JWT', { openid, iat: now, exp });
            const jwt = await signJwt(
                { openid, nickname, iat: now, exp },
                env.JWT_SECRET,
            );
            AuthController.log('callback', '✅ JWT 签发成功', { tokenLength: jwt.length });

            /* ⑤ Set-Cookie & 302 跳回前端 */
            const frontendUrl = env.FRONTEND_URL || url.origin;
            const redirectTo = state.startsWith('http') ? state : `${frontendUrl}${state}`;
            AuthController.log('callback', '⑤ 登录完成，302 跳转', { redirectTo, frontendUrl, state });

            const cookieParts = [
                `token=${jwt}`,
                'Path=/',
                'HttpOnly',
                'Secure',
                'SameSite=Lax',
                `Max-Age=${7 * 24 * 3600}`,
            ];
            if (env.COOKIE_DOMAIN) {
                cookieParts.push(`Domain=${env.COOKIE_DOMAIN}`);
            }
            const cookie = cookieParts.join('; ');

            return new Response(null, {
                status: 302,
                headers: {
                    Location: redirectTo,
                    'Set-Cookie': cookie,
                },
            });
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const errStack = err instanceof Error ? err.stack : undefined;
            AuthController.log('callback', '❌ 登录流程异常', { error: errMsg, stack: errStack });
            return createResponse(500, `微信登录失败: ${errMsg}`);
        }
    }

    /* ──────────── 3. 退出登录 ──────────── */

    static async logout(request: Request, env: Env): Promise<Response> {
        AuthController.log('logout', '收到登出请求', { url: request.url });

        const cookieParts = [
            'token=deleted',
            'Path=/',
            'HttpOnly',
            'Secure',
            'SameSite=Lax',
            'Max-Age=0',
            'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        ];
        if (env.COOKIE_DOMAIN) {
            cookieParts.push(`Domain=${env.COOKIE_DOMAIN}`);
        }
        const cookie = cookieParts.join('; ');

        const resp = createResponse(200, 'success', null);
        const headers = new Headers(resp.headers);
        headers.append('Set-Cookie', cookie);

        return new Response(resp.body, {
            status: resp.status,
            headers,
        });
    }

    /* ──────────── 私有方法 ──────────── */

    /**
     * 用 code 换取 access_token
     */
    private static async exchangeCodeForToken(code: string, env: Env): Promise<any> {
        const res = await fetch(
            `https://api.weixin.qq.com/sns/oauth2/access_token` +
            `?appid=${env.WECHAT_APPID}` +
            `&secret=${env.WECHAT_SECRET}` +
            `&code=${code}` +
            `&grant_type=authorization_code`,
        );
        return res.json();
    }

    /**
     * 通过 access_token + openid 拉取微信用户基本信息
     */
    private static async fetchWechatUserInfo(accessToken: string, openid: string): Promise<any> {
        const res = await fetch(
            `https://api.weixin.qq.com/sns/userinfo` +
            `?access_token=${accessToken}` +
            `&openid=${openid}` +
            `&lang=zh_CN`,
        );
        return res.json();
    }

    /**
     * 查询或新建用户（UPSERT）
     */
    private static async upsertUser(db: D1Database, openid: string, nickname: string, avatarUrl: string): Promise<void> {
        await db
            .prepare(
                `INSERT INTO users (openid, nickname, avatar_url)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(openid) DO UPDATE SET
                     nickname = excluded.nickname,
                     avatar_url = excluded.avatar_url`,
            )
            .bind(openid, nickname, avatarUrl)
            .run();
    }
}
