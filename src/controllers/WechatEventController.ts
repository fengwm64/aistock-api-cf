import { createResponse } from '../utils/response';
import { ScanLoginController } from './ScanLoginController';
import type { Env } from '../index';

/**
 * 微信消息与事件推送（服务器配置校验 + 消息/事件回调）
 * 文档: https://developers.weixin.qq.com/doc/service/guide/dev/push/
 *
 * 已支持事件:
 *  - subscribe（首次关注，含带参二维码场景）
 *  - SCAN（已关注用户扫码）
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

    /* ──────── 简易 XML 标签提取（避免引入 XML 解析库） ──────── */

    private static extractXmlTag(xml: string, tag: string): string {
        // 匹配 <Tag><![CDATA[value]]></Tag> 或 <Tag>value</Tag>
        const cdataRe = new RegExp(`<${tag}><!\\[CDATA\\[([^\\]]*?)\\]\\]></${tag}>`);
        const cdataMatch = xml.match(cdataRe);
        if (cdataMatch) return cdataMatch[1];

        const plainRe = new RegExp(`<${tag}>([^<]*)</${tag}>`);
        const plainMatch = xml.match(plainRe);
        return plainMatch ? plainMatch[1] : '';
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

        // ── POST: 解析 XML 消息体 ──
        const body = await request.text();
        WechatEventController.log('push', '收到推送', { length: body.length, preview: body.slice(0, 300) });

        const msgType = WechatEventController.extractXmlTag(body, 'MsgType');
        const fromUser = WechatEventController.extractXmlTag(body, 'FromUserName'); // 即 openid

        if (msgType === 'event') {
            const event = WechatEventController.extractXmlTag(body, 'Event');
            const eventKey = WechatEventController.extractXmlTag(body, 'EventKey');

            WechatEventController.log('push', '事件类型', { event, eventKey, openid: fromUser });

            if (event === 'subscribe' || event === 'SCAN') {
                // subscribe 事件中 EventKey 前缀为 qrscene_，SCAN 事件无前缀
                const sceneStr = event === 'subscribe'
                    ? eventKey.replace(/^qrscene_/, '')
                    : eventKey;

                if (sceneStr && sceneStr.startsWith('login_')) {
                    WechatEventController.log('push', '🔑 扫码登录事件，转交 ScanLoginController', { sceneStr, openid: fromUser });
                    try {
                        await ScanLoginController.handleScanEvent(env, fromUser, sceneStr);
                        WechatEventController.log('push', '✅ ScanLoginController 处理完成');
                    } catch (err: any) {
                        WechatEventController.log('push', '❌ ScanLoginController 处理失败', { 
                            error: err instanceof Error ? err.message : String(err),
                            stack: err instanceof Error ? err.stack : undefined
                        });
                    }
                } else {
                    WechatEventController.log('push', '普通关注/扫码事件（非登录场景）', { sceneStr });
                }
            } else {
                WechatEventController.log('push', '其他事件，暂不处理', { event });
            }
        } else {
            WechatEventController.log('push', '非事件消息，暂不处理', { msgType });
        }

        // 微信要求 5 秒内返回，返回 success 表示不需要被动回复
        return new Response('success', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
}
