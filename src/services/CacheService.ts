/**
 * KV 缓存服务
 * 封装 Cloudflare Workers KV 操作
 */
export class CacheService {
    constructor(
        private readonly kv: KVNamespace,
        private readonly ctx: ExecutionContext,
    ) {}

    /** 获取缓存数据 */
    async get<T>(key: string): Promise<T | null> {
        return this.kv.get<T>(key, 'json');
    }

    /** 设置缓存数据（同步等待写入完成） */
    async put<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
        if (!Number.isFinite(ttlSeconds)) {
            throw new Error(`Invalid TTL for key ${key}: ${ttlSeconds}`);
        }
        const normalizedTtlSeconds = Math.max(60, Math.floor(ttlSeconds));
        await this.kv.put(key, JSON.stringify(value), { expirationTtl: normalizedTtlSeconds });
    }

    /** 设置缓存数据（后台异步写入，不阻塞响应） */
    set<T>(key: string, value: T, ttlSeconds: number): void {
        this.ctx.waitUntil(this.put(key, value, ttlSeconds));
    }

    /** 刷新缓存 TTL */
    refresh<T>(key: string, value: T, ttlSeconds: number): void {
        this.set(key, value, ttlSeconds);
    }
}
