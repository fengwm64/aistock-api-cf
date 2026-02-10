/**
 * JWT 工具 — 基于 Web Crypto API (HMAC-SHA256)
 * 适用于 Cloudflare Workers 环境
 */

function base64UrlEncode(data: Uint8Array): string {
    let binary = '';
    for (const byte of data) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    const pad = str.length % 4;
    if (pad) str += '='.repeat(4 - pad);
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function textEncode(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

async function getSigningKey(secret: string): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        'raw',
        textEncode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
    );
}

export interface JwtPayload {
    openid: string;
    nickname?: string;
    iat: number;
    exp: number;
}

/**
 * 签发 JWT
 */
export async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
    const header = { alg: 'HS256', typ: 'JWT' };
    const headerB64 = base64UrlEncode(textEncode(JSON.stringify(header)));
    const payloadB64 = base64UrlEncode(textEncode(JSON.stringify(payload)));

    const signingInput = `${headerB64}.${payloadB64}`;
    const key = await getSigningKey(secret);
    const signature = await crypto.subtle.sign('HMAC', key, textEncode(signingInput));

    return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * 验证并解析 JWT，返回 payload；无效则返回 null
 */
export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;
    const key = await getSigningKey(secret);
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = base64UrlDecode(signatureB64);

    const valid = await crypto.subtle.verify('HMAC', key, signature, textEncode(signingInput));
    if (!valid) return null;

    try {
        const payload: JwtPayload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
        if (payload.exp && Date.now() / 1000 > payload.exp) return null;
        return payload;
    } catch {
        return null;
    }
}
