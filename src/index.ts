
import { ProfitForecastController } from './controllers/ProfitForecastController';
import { createResponse } from './utils/response';

console.log("Worker script loaded.");

/**
 * Cloudflare Worker 架构介绍:
 * 
 * 本项目采用 Clean Architecture 分层设计:
 * - src/index.ts: 入口文件，负责路由分发 (No Library, Manually Handled)。
 * - src/controllers: 控制器层，处理 HTTP 请求参数解析和响应格式化。
 * - src/services: 服务层，处理核心业务逻辑 (如请求同花顺数据、编码处理)。
 * - src/utils: 工具层，包含通用的解析逻辑 (HTML Parser) 和响应辅助函数。
 * 
 * 技术栈:
 * - Runtime: Cloudflare Workers
 * - Router: 手写轻量级路由 (无外部依赖)
 * - HTML Parsing: cheerio
 * - Encoding: Native TextDecoder (Gb2312/GBK support)
 */

export interface Env {
    // 环境变量接口定义
    AISTOCK: KVNamespace;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        try {
            const url = new URL(request.url);
            
            // 简单的手动路由实现
            // 仅处理 GET 请求
            if (request.method === 'GET') {
                const path = url.pathname;
                
                // 1. 匹配 /api/cn/stock/profit-forecast/:symbol
                const prefix = '/api/cn/stock/profit-forecast/';
                if (path.startsWith(prefix)) {
                    // 提取 symbol
                    const symbol = path.slice(prefix.length);
                    // 过滤掉可能的尾部斜杠或空字符串
                    if (symbol && symbol.length > 0) {
                        // 安全校验：symbol 只能是数字或字母，长度 10 以内
                        if (symbol.length > 10 || !/^[a-zA-Z0-9]+$/.test(symbol)) {
                            return createResponse(400, "Invalid symbol - 只能包含数字或字母，且长度不可超过10位");
                        }
                         return await ProfitForecastController.getThsForecast(symbol, env, ctx);
                    }
                }
            }

            // 404 处理
            return createResponse(404, "Not Found - 请使用 /api/cn/stock/profit-forecast/股票代码");
            
        } catch (err: any) {
            return createResponse(500, err instanceof Error ? err.message : 'Internal Server Error');
        }
	},
};


