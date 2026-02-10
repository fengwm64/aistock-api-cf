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

    /* ──────────── 1. 跳转微信授权 ──────────── */

    static async login(request: Request, env: Env): Promise<Response> {
        const appid = env.WECHAT_APPID;
        if (!appid) {
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

        return Response.redirect(authUrl, 302);
    }

    /* ──────────── 2. 微信回调 ──────────── */

    static async callback(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state') || '/';

        if (!code) {
            return createResponse(400, '缺少 code 参数');
        }

        try {
            /* ① code 换 access_token + openid */
            const tokenData = await AuthController.exchangeCodeForToken(code, env);
            if (tokenData.errcode) {
                return createResponse(400, `微信授权失败: ${tokenData.errmsg}`);
            }

            const { access_token, openid } = tokenData;

            /* ② 拉取用户信息（snsapi_userinfo） */
            const userInfo = await AuthController.fetchWechatUserInfo(access_token, openid);

            const nickname = userInfo.nickname || '';
            const avatarUrl = userInfo.headimgurl || '';

            /* ③ 查询 / 新建用户（D1） */
            await AuthController.upsertUser(env.DB, openid, nickname, avatarUrl);

            /* ④ 签发 JWT */
            const now = Math.floor(Date.now() / 1000);
            const jwt = await signJwt(
                { openid, nickname, iat: now, exp: now + 7 * 24 * 3600 },
                env.JWT_SECRET,
            );

            /* ⑤ Set-Cookie & 302 跳回前端 */
            const frontendUrl = env.FRONTEND_URL || url.origin;
            const redirectTo = state.startsWith('http') ? state : `${frontendUrl}${state}`;

            return new Response(null, {
                status: 302,
                headers: {
                    Location: redirectTo,
                    'Set-Cookie': `token=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 24 * 3600}`,
                },
            });
        } catch (err: any) {
            return createResponse(500, `微信登录失败: ${err instanceof Error ? err.message : String(err)}`);
        }
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
