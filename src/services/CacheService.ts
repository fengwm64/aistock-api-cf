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

    /** 设置缓存数据（后台异步写入，不阻塞响应） */
    set<T>(key: string, value: T, ttlSeconds: number): void {
        this.ctx.waitUntil(
            this.kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds }),
        );
    }

    /** 刷新缓存 TTL */
    refresh(key: string, value: any, ttlSeconds: number): void {
        this.set(key, value, ttlSeconds);
    }
}
