import { signJwt } from '../utils/jwt';
import { createResponse } from '../utils/response';
import type { Env } from '../index';

/**
 * 微信扫码登录控制器
 *
 * 流程:
 *  1. GET  /api/auth/wechat/login/scan           → 生成带参二维码，返回 state + qr_url
 *  2. 微信推送 subscribe/SCAN 事件到 /api/auth/wechat/push → WechatEventController 调用 handleScanEvent
 *  3. GET  /api/auth/wechat/login/scan/poll?state= → 前端轮询登录结果
 */
export class ScanLoginController {

    private static log(stage: string, message: string, data?: any): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[ScanLogin][${stage}] ${ts} ${message}${detail}`);
    }

    /* ──────── KV Key ──────── */

    private static kvKey(state: string): string {
        return `scan_login:${state}`;
    }

    /* ──────── 微信服务端 access_token（非 OAuth，用于接口调用） ──────── */

    static async getServerAccessToken(env: Env): Promise<string> {
        const cacheKey = 'wechat:server_access_token';
        const cached = await env.KV.get(cacheKey);
        if (cached) {
            ScanLoginController.log('accessToken', '命中 KV 缓存');
            return cached;
        }

        ScanLoginController.log('accessToken', '请求微信获取 server access_token');
        const res = await fetch(
            `https://api.weixin.qq.com/cgi-bin/token` +
            `?grant_type=client_credential` +
            `&appid=${env.WECHAT_APPID}` +
            `&secret=${env.WECHAT_SECRET}`,
        );
        const data: any = await res.json();

        if (data.errcode) {
            ScanLoginController.log('accessToken', '❌ 获取失败', { errcode: data.errcode, errmsg: data.errmsg });
            throw new Error(`获取 server access_token 失败: ${data.errmsg}`);
        }

        const token: string = data.access_token;
        const expiresIn: number = data.expires_in || 7200;
        // 提前 200 秒过期，避免边界问题
        await env.KV.put(cacheKey, token, { expirationTtl: Math.max(expiresIn - 200, 60) });
        ScanLoginController.log('accessToken', '✅ 获取成功，已缓存', { expiresIn });
        return token;
    }

    /* ──────── 1. 生成扫码二维码 ──────── */

    static async generateQrCode(request: Request, env: Env): Promise<Response> {
        ScanLoginController.log('generateQr', '收到生成二维码请求');

        try {
            // 生成唯一 state
            const state = crypto.randomUUID().replace(/-/g, '');
            const sceneStr = `login_${state}`;

            // 获取 server access_token
            const accessToken = await ScanLoginController.getServerAccessToken(env);

            // 调用微信接口创建临时二维码（5 分钟有效）
            ScanLoginController.log('generateQr', '调用微信创建临时二维码', { sceneStr });
            const wxRes = await fetch(
                `https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=${accessToken}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        expire_seconds: 300,
                        action_name: 'QR_STR_SCENE',
                        action_info: { scene: { scene_str: sceneStr } },
                    }),
                },
            );
            const wxData: any = await wxRes.json();

            if (wxData.errcode) {
                ScanLoginController.log('generateQr', '❌ 创建二维码失败', { errcode: wxData.errcode, errmsg: wxData.errmsg });
                return createResponse(500, `创建二维码失败: ${wxData.errmsg}`);
            }

            const ticket: string = wxData.ticket;
            const qrUrl = `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(ticket)}`;

            // 在 KV 中存储登录状态，5 分钟过期
            await env.KV.put(
                ScanLoginController.kvKey(state),
                JSON.stringify({ status: 'pending' }),
                { expirationTtl: 300 },
            );

            ScanLoginController.log('generateQr', '✅ 二维码生成成功', { state, ticket: ticket.slice(0, 20) + '...' });

            return createResponse(200, 'success', {
                state,
                qr_url: qrUrl,
                expire_seconds: 300,
            });
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            ScanLoginController.log('generateQr', '❌ 生成二维码异常', { error: errMsg });
            return createResponse(500, `生成二维码失败: ${errMsg}`);
        }
    }

    /* ──────── 2. 处理扫码事件（由 WechatEventController 调用） ──────── */

    static async handleScanEvent(env: Env, openid: string, sceneStr: string): Promise<void> {
        ScanLoginController.log('scanEvent', '收到扫码事件', { openid, sceneStr });

        try {
            // sceneStr 格式: login_<state>
            if (!sceneStr.startsWith('login_')) {
                ScanLoginController.log('scanEvent', '⏭️ 非登录场景，跳过', { sceneStr });
                return;
            }

            const state = sceneStr.replace('login_', '');
            const key = ScanLoginController.kvKey(state);
            
            ScanLoginController.log('scanEvent', '开始查询 KV', { key, state });
            const raw = await env.KV.get(key);

            if (!raw) {
                ScanLoginController.log('scanEvent', '❌ state 不存在或已过期', { state });
                return;
            }

            ScanLoginController.log('scanEvent', 'KV 原始数据', { raw });
            const record = JSON.parse(raw);
            
            if (record.status !== 'pending') {
                ScanLoginController.log('scanEvent', '⏭️ state 非 pending，跳过', { state, status: record.status });
                return;
            }

            // 查询 / 新建用户（UPSERT，扫码关注场景可能没有昵称头像，先占位）
            ScanLoginController.log('scanEvent', '开始 UPSERT 用户', { openid });
            await env.DB
                .prepare(
                    `INSERT INTO users (openid, nickname, avatar_url)
                     VALUES (?1, '', '')
                     ON CONFLICT(openid) DO UPDATE SET openid = excluded.openid`,
                )
                .bind(openid)
                .run();
            ScanLoginController.log('scanEvent', 'UPSERT 用户完成');

            // 签发 JWT
            const now = Math.floor(Date.now() / 1000);
            const exp = now + 7 * 24 * 3600;
            ScanLoginController.log('scanEvent', '开始签发 JWT', { openid, now, exp });
            const jwt = await signJwt({ openid, iat: now, exp }, env.JWT_SECRET);
            ScanLoginController.log('scanEvent', 'JWT 签发完成', { jwtLength: jwt.length });

            // 更新 KV 状态为 confirmed，写入 JWT，保留 5 分钟给前端轮询
            const newRecord = { status: 'confirmed', openid, jwt };
            ScanLoginController.log('scanEvent', '准备更新 KV 状态', { key, newRecord: { ...newRecord, jwt: '***' } });
            
            await env.KV.put(
                key,
                JSON.stringify(newRecord),
                { expirationTtl: 300 },
            );

            ScanLoginController.log('scanEvent', '✅ 登录确认完成', { state, openid });
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const errStack = err instanceof Error ? err.stack : undefined;
            ScanLoginController.log('scanEvent', '❌❌❌ 处理扫码事件异常', { 
                error: errMsg, 
                stack: errStack,
                openid, 
                sceneStr 
            });
            throw err; // 重新抛出让上层知道失败了
        }
    }

    /* ──────── 3. 前端轮询登录状态 ──────── */

    static async poll(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const state = url.searchParams.get('state');

        ScanLoginController.log('poll', '收到轮询请求', { state });

        if (!state) {
            return createResponse(400, '缺少 state 参数');
        }

        const raw = await env.KV.get(ScanLoginController.kvKey(state));

        if (!raw) {
            ScanLoginController.log('poll', '❌ state 不存在或已过期', { state });
            return createResponse(404, '二维码已过期或 state 无效');
        }

        const record = JSON.parse(raw);

        if (record.status === 'pending') {
            ScanLoginController.log('poll', '⏳ 等待扫码', { state });
            return createResponse(200, 'pending', { status: 'pending' });
        }

        if (record.status === 'confirmed') {
            ScanLoginController.log('poll', '✅ 登录已确认，返回 JWT', { state, openid: record.openid });

            // 构建 Set-Cookie
            const cookieParts = [
                `token=${record.jwt}`,
                'Path=/',
                'HttpOnly',
                'Secure',
                'SameSite=Lax',
                `Max-Age=${7 * 24 * 3600}`,
            ];
            if (env.COOKIE_DOMAIN) {
                cookieParts.push(`Domain=${env.COOKIE_DOMAIN}`);
            }
            const cookieStr = cookieParts.join('; ');

            ScanLoginController.log('poll', 'Set-Cookie 内容', { cookie: cookieStr.replace(/token=[^;]+/, 'token=***') });

            const resp = createResponse(200, 'confirmed', { 
                status: 'confirmed', 
                openid: record.openid,
                timestamp: new Date().toISOString()
            });
            const headers = new Headers(resp.headers);
            headers.append('Set-Cookie', cookieStr);

            // 标记为已消费，延迟删除，给前端多次重试机会（60秒）
            if (!record.consumed) {
                await env.KV.put(
                    ScanLoginController.kvKey(state),
                    JSON.stringify({ ...record, consumed: true }),
                    { expirationTtl: 60 }
                );
                ScanLoginController.log('poll', '标记为已消费，60秒后自动过期');
            }

            const finalResponse = new Response(resp.body, { status: resp.status, headers });
            ScanLoginController.log('poll', '返回响应', { 
                status: finalResponse.status,
                hasSetCookie: finalResponse.headers.has('Set-Cookie'),
                contentType: finalResponse.headers.get('Content-Type')
            });
            
            return finalResponse;
        }

        // 未知状态
        return createResponse(200, record.status, { status: record.status });
    }
}
