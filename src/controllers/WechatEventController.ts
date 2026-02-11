import { createResponse } from '../utils/response';
import type { Env } from '../index';

/**
 * 微信消息与事件推送（服务器配置校验 + 消息回调）
 * 文档: https://developers.weixin.qq.com/doc/service/guide/dev/push/
 */
export class WechatEventController {
    private static log(stage: string, message: string, data?: any): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[WxEvent][${stage}] ${ts} ${message}${detail}`);
    }

    private static async sha1Hex(content: string): Promise<string> {
        const encoder = new TextEncoder();
        const data = encoder.encode(content);
        const hash = await crypto.subtle.digest('SHA-1', data);
        const bytes = new Uint8Array(hash);
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    private static async verifySignature(env: Env, timestamp?: string, nonce?: string, signature?: string): Promise<boolean> {
        if (!timestamp || !nonce || !signature) return false;
        const token = env.WECHAT_TOKEN;
        if (!token) return false;
        const raw = [token, timestamp, nonce].sort().join('');
        const expected = await WechatEventController.sha1Hex(raw);
        return expected === signature;
    }

    /**
     * GET: 用于微信服务器首次校验
     * POST: 微信消息/事件推送
     */
    static async handle(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const signature = url.searchParams.get('signature') || undefined;
        const timestamp = url.searchParams.get('timestamp') || undefined;
        const nonce = url.searchParams.get('nonce') || undefined;
        const echostr = url.searchParams.get('echostr') || undefined;

        const ok = await WechatEventController.verifySignature(env, timestamp, nonce, signature);
        if (!ok) {
            WechatEventController.log('verify', '❌ 签名校验失败', { signature, timestamp, nonce });
            return createResponse(401, 'invalid signature');
        }

        if (request.method === 'GET') {
            WechatEventController.log('verify', '✅ 校验成功，回显 echostr', { echostr });
            return new Response(echostr || '', { status: 200, headers: { 'Content-Type': 'text/plain' } });
        }

        // 处理消息/事件，当前仅记录原始 XML，返回 success 避免重试
        const body = await request.text();
        WechatEventController.log('push', '✅ 收到消息/事件', { length: body.length, preview: body.slice(0, 200) });
        return new Response('success', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
}
