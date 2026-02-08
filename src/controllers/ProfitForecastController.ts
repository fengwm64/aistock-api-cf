import { ThsService } from '../services/ThsService';
import { CacheService } from '../services/CacheService';
import { createResponse } from '../utils/response';
import { Env } from '../index';

export class ProfitForecastController {
    static async getThsForecast(symbol: string, env: Env, ctx: ExecutionContext) {
        if (!symbol) {
            return createResponse(400, "Missing symbol parameter. Usage: /api/cn/stock/profit-forecast/600519");
        }
        
        const symbolStr = symbol;

        // 缓存配置
        const CACHE_KEY = `profit_forecast:${symbolStr}`;
        const CACHE_TTL = 7 * 24 * 60 * 60; // 7天 (秒)
        
        try {
            // 初始化缓存服务
            // 假设 Env 中有名为 AISTOCK 的 KVNamespace
            // 如果未配置 KV，则跳过缓存逻辑直接请求
            let cachedWrapper: any = null;
            let cacheService = null;

            if (env.AISTOCK) {
                cacheService = new CacheService(env.AISTOCK, ctx);
                cachedWrapper = await cacheService.get(CACHE_KEY);
            }

            // 检查缓存格式 (兼容旧缓存：如果是旧格式则视为无缓存或重新获取，这里选择重新获取以确保有时间戳)
            // 新格式 expect: { timestamp: number, data: any }
            if (cachedWrapper && typeof cachedWrapper === 'object' && cachedWrapper.timestamp && cachedWrapper.data) {
                // 命中缓存：后台刷新 TTL
                if (cacheService) {
                    console.log(`Cache hit for ${symbolStr}, refreshing TTL...`);
                    // 异步重写 KV 以重置 TTL
                    cacheService.refresh(CACHE_KEY, cachedWrapper, CACHE_TTL);
                }
                
                // 格式化时间 UTC+8
                const updateTime = ProfitForecastController.formatToChinaTime(cachedWrapper.timestamp);
                
                const responseData = {
                    symbol: symbolStr,
                    updateTime: updateTime,
                    ...cachedWrapper.data
                };

                return createResponse(200, "success (cached)", responseData);
            }

            // 未命中缓存或缓存格式不兼容：请求源数据
            const data = await ThsService.getProfitForecast(symbolStr as string);
            const now = Date.now();
            
            const wrapper = {
                timestamp: now,
                data: data
            };

            // 写入缓存
            if (cacheService) {
                console.log(`Cache miss for ${symbolStr}, writing to KV...`);
                cacheService.set(CACHE_KEY, wrapper, CACHE_TTL);
            }

            // 格式化时间 UTC+8
            const updateTime = ProfitForecastController.formatToChinaTime(now);

            const responseData = {
                symbol: symbolStr,
                updateTime: updateTime,
                ...data
            };

            return createResponse(200, "success", responseData);
        } catch (error: any) {
            return createResponse(500, error.message);
        }
    }

    private static formatToChinaTime(timestamp: number): string {
        const date = new Date(timestamp);
        // UTC+8
        const offset = 8;
        // get time in ms, add offset hours
        const utc8Time = date.getTime() + (date.getTimezoneOffset() * 60000) + (offset * 3600000);
        const d = new Date(utc8Time);
        
        const pad = (n: number) => n.toString().padStart(2, '0');
        
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
               `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
}
