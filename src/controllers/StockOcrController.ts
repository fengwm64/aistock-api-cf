import type { Env } from '../index';
import { createResponse } from '../utils/response';
import { StockOcrService, type StockOcrOptions } from '../services/StockOcrService';

/**
 * 自选股图片 OCR 控制器
 * POST /api/cn/stocks/ocr
 */
export class StockOcrController {
    static async batchOcr(request: Request, env: Env): Promise<Response> {
        if (request.method !== 'POST') {
            return createResponse(405, 'Method Not Allowed - 仅支持 POST');
        }

        if (!request.headers.get('Content-Type')?.includes('application/json')) {
            return createResponse(400, 'Content-Type 必须为 application/json');
        }

        let body: any = null;
        try {
            body = await request.json();
        } catch {
            return createResponse(400, '请求体必须是 JSON');
        }

        const images = body?.images ?? body?.image_list ?? body?.imgs;
        if (!Array.isArray(images)) {
            return createResponse(400, 'images 必须是数组');
        }

        const hint = typeof body?.hint === 'string'
            ? body.hint
            : (typeof body?.ocrHint === 'string' ? body.ocrHint : '');
        const ocrOptions: StockOcrOptions = {
            batchConcurrency: body?.batchConcurrency ?? body?.ocrOptions?.batchConcurrency,
            maxImagesPerRequest: body?.maxImagesPerRequest ?? body?.ocrOptions?.maxImagesPerRequest,
            timeoutMs: body?.timeoutMs ?? body?.ocrOptions?.timeoutMs,
        };

        try {
            const normalizedImages = StockOcrService.normalizeImages(images);
            const data = await StockOcrService.recognizeStocksFromImages(normalizedImages, env, hint, ocrOptions);
            return createResponse(200, 'success', data);
        } catch (error: any) {
            const message = error instanceof Error ? error.message : 'Internal Server Error';
            if (message.includes('images') || message.includes('图片')) {
                return createResponse(400, message);
            }
            return createResponse(500, message);
        }
    }
}
