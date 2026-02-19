import type { Env } from '../index';
import { StockAnalysisService } from '../services/StockAnalysisService';
import { createResponse } from '../utils/response';

/**
 * 个股 AI 评价控制器
 * RESTful 路径: /api/cn/stocks/:symbol/analysis
 */
export class StockAnalysisController {
    private static readonly DEFAULT_PAGE_SIZE = 20;
    private static readonly MAX_PAGE_SIZE = 100;

    private static isSseRequested(request: Request): boolean {
        const accept = (request.headers.get('accept') || '').toLowerCase();
        return accept.includes('text/event-stream');
    }

    private static parseHistoryParams(request: Request): { page: number; pageSize: number } | { error: string } {
        const url = new URL(request.url);
        const pageRaw = (url.searchParams.get('page') || '').trim();
        const pageSizeRaw = (url.searchParams.get('pageSize') || '').trim();

        let page = 1;
        if (pageRaw) {
            const parsed = Number(pageRaw);
            if (!Number.isInteger(parsed) || parsed < 1) {
                return { error: 'Invalid page - page 必须是大于0的整数' };
            }
            page = parsed;
        }

        let pageSize = this.DEFAULT_PAGE_SIZE;
        if (pageSizeRaw) {
            const parsed = Number(pageSizeRaw);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > this.MAX_PAGE_SIZE) {
                return { error: `Invalid pageSize - pageSize 必须是 1-${this.MAX_PAGE_SIZE} 的整数` };
            }
            pageSize = parsed;
        }

        return { page, pageSize };
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

    static async getStockAnalysisHistory(symbol: string, request: Request, env: Env, ctx: ExecutionContext) {
        if (!symbol || !/^\d{6}$/.test(symbol)) {
            return createResponse(400, 'Invalid symbol - A股代码必须是6位数字');
        }

        if (request.method !== 'GET') {
            return createResponse(405, 'Method Not Allowed - 仅支持 GET');
        }

        const parsed = this.parseHistoryParams(request);
        if ('error' in parsed) {
            return createResponse(400, parsed.error);
        }

        try {
            const data = await StockAnalysisService.getStockAnalysisHistory(
                symbol,
                env,
                parsed.page,
                parsed.pageSize,
            );
            if ((data['总数量'] as number) === 0) {
                return createResponse(404, `未找到该股票的历史分析记录: ${symbol}`);
            }
            return createResponse(200, 'success', data);
        } catch (error: any) {
            const message = error instanceof Error ? error.message : 'Internal Server Error';
            return createResponse(500, message);
        }
    }
}
