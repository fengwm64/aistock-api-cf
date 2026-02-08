import { ThsService } from '../services/ThsService';
import { CacheService } from '../services/CacheService';
import { createResponse } from '../utils/response';
import { Env } from '../index';

export class ProfitForecastController {
    static async getThsForecast(symbol: string, env: Env, ctx: ExecutionContext) {
        if (!symbol) {
            return createResponse(400, "Missing symbol parameter. Usage: /profit-forecast/600519");
        }
        
        const symbolStr = symbol;

        // 缓存配置
        const CACHE_KEY = `profit_forecast:${symbolStr}`;
        const CACHE_TTL = 5 * 24 * 60 * 60; // 5天 (秒)
        
        try {
            // 初始化缓存服务
            // 假设 Env 中有名为 AISTOCK 的 KVNamespace
            // 如果未配置 KV，则跳过缓存逻辑直接请求
            let cachedData = null;
            let cacheService = null;

            if (env.AISTOCK) {
                cacheService = new CacheService(env.AISTOCK, ctx);
                cachedData = await cacheService.get(CACHE_KEY);
            }

            if (cachedData) {
                // 命中缓存：后台刷新 TTL，立即返回数据
                if (cacheService) {
                    console.log(`Cache hit for ${symbolStr}, refreshing TTL...`);
                    // 异步重写 KV 以重置 TTL
                    cacheService.refresh(CACHE_KEY, cachedData, CACHE_TTL);
                }
                return createResponse(200, "success (cached)", cachedData);
            }

            // 未命中缓存：请求源数据
            const data = await ThsService.getProfitForecast(symbolStr as string);

            // 写入缓存
            if (cacheService) {
                console.log(`Cache miss for ${symbolStr}, writing to KV...`);
                cacheService.set(CACHE_KEY, data, CACHE_TTL);
            }

            return createResponse(200, "success", data);
        } catch (error: any) {
            return createResponse(500, error.message);
        }
    }
}
