import type { Env } from '../index';
import { StockAnalysisService } from '../services/StockAnalysisService';
import { createResponse } from '../utils/response';

/**
 * 个股 AI 评价控制器
 * RESTful 路径: /api/cn/stocks/:symbol/analysis
 */
export class StockAnalysisController {
    private static isSseRequested(request: Request): boolean {
        const accept = (request.headers.get('accept') || '').toLowerCase();
        return accept.includes('text/event-stream');
    }

    private static encodeSseEvent(encoder: TextEncoder, event: string, payload: unknown): Uint8Array {
        const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const lines = raw.split(/\r?\n/).map(line => `data: ${line}`).join('\n');
        return encoder.encode(`event: ${event}\n${lines}\n\n`);
    }

    private static createStockAnalysisSseResponse(symbol: string, env: Env): Response {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start: async (controller) => {
                const send = (event: string, payload: unknown) => {
                    controller.enqueue(this.encodeSseEvent(encoder, event, payload));
                };

                const heartbeat = setInterval(() => {
                    controller.enqueue(encoder.encode(': keep-alive\n\n'));
                }, 15_000);

                try {
                    send('start', {
                        message: '开始刷新个股评价',
                        symbol,
                    });

                    const data = await StockAnalysisService.createStockAnalysis(
                        symbol,
                        env,
                        (progress) => {
                            send('progress', progress);
                        },
                        (delta) => {
                            send('model.delta', delta);
                        },
                    );

                    send('result', data);
                    send('done', {
                        message: 'success',
                    });
                } catch (error: any) {
                    const message = error instanceof Error ? error.message : 'Internal Server Error';
                    const code = message.includes('股票代码不存在') ? 404 : 500;
                    send('error', { code, message });
                } finally {
                    clearInterval(heartbeat);
                    controller.close();
                }
            },
        });

        return new Response(body, {
            status: 200,
            headers: {
                'Content-Type': 'text/event-stream;charset=UTF-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            },
        });
    }

    static async handleStockAnalysis(symbol: string, request: Request, env: Env, ctx: ExecutionContext) {
        if (!symbol || !/^\d{6}$/.test(symbol)) {
            return createResponse(400, 'Invalid symbol - A股代码必须是6位数字');
        }

        if (request.method === 'POST') {
            if (this.isSseRequested(request)) {
                return this.createStockAnalysisSseResponse(symbol, env);
            }
            try {
                const data = await StockAnalysisService.createStockAnalysis(symbol, env);
                return createResponse(200, 'success', data);
            } catch (error: any) {
                const message = error instanceof Error ? error.message : 'Internal Server Error';
                if (message.includes('股票代码不存在')) {
                    return createResponse(404, message);
                }
                return createResponse(500, message);
            }
        }

        if (request.method === 'GET') {
            try {
                const data = await StockAnalysisService.getLatestStockAnalysis(symbol, env);
                if (!data) {
                    return createResponse(404, `未找到该股票的分析记录: ${symbol}`);
                }
                return createResponse(200, 'success', data);
            } catch (error: any) {
                const message = error instanceof Error ? error.message : 'Internal Server Error';
                if (message.includes('股票代码不存在')) {
                    return createResponse(404, message);
                }
                return createResponse(500, message);
            }
        }

        return createResponse(405, 'Method Not Allowed - 仅支持 GET/POST');
    }
}
