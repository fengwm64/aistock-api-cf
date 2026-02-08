export class CacheService {
    private kv: KVNamespace;
    private ctx: ExecutionContext;

    constructor(kv: KVNamespace, ctx: ExecutionContext) {
        this.kv = kv;
        this.ctx = ctx;
    }

    /**
     * 获取缓存数据
     * @param key 缓存键
     * @returns 缓存数据或 null
     */
    async get<T>(key: string): Promise<T | null> {
        return this.kv.get<T>(key, 'json');
    }

    /**
     * 设置缓存数据
     * @param key 缓存键
     * @param value 缓存值
     * @param ttlSeconds 过期时间（秒）
     */
    async set(key: string, value: any, ttlSeconds: number): Promise<void> {
        // 使用 ctx.waitUntil 确保写入操作不阻塞响应，并在后台完成
        this.ctx.waitUntil(
            this.kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds })
        );
    }

    /**
     * 刷新缓存过期时间
     * @param key 缓存键
     * @param value 当前缓存值 (KV put 需要 value 才能重置 TTL)
     * @param ttlSeconds 新的过期时间（秒）
     */
    async refresh(key: string, value: any, ttlSeconds: number): Promise<void> {
        await this.set(key, value, ttlSeconds);
    }
}
