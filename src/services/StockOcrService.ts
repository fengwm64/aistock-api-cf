import type { Env } from '../index';

export interface StockOcrItem {
    '股票简称': string;
    '股票代码': string;
}

export class StockOcrService {
    private static readonly MAX_IMAGES = 8;
    private static readonly MAX_IMAGES_PER_REQUEST = 4;
    private static readonly MAX_BASE64_CHARS = 6_000_000;
    private static readonly DEFAULT_MIME = 'image/png';

    private static readonly SYSTEM_PROMPT = '你是严格的 JSON 输出助手。必须只输出 JSON，不得输出多余解释。';

    private static normalizeText(value: unknown): string {
        if (typeof value !== 'string') return '';
        return value.trim().replace(/\s+/g, ' ');
    }

    private static normalizeStockCode(raw: string): string {
        const cleaned = raw.trim();
        if (!cleaned) return '';
        const match = cleaned.match(/\d{6}/);
        if (match) return match[0];
        return cleaned.replace(/\s+/g, '').toUpperCase();
    }

    private static parseItemFromString(raw: string): StockOcrItem | null {
        const text = this.normalizeText(raw);
        if (!text) return null;
        const nameMatch = text.match(/股票简称\s*[:：]\s*([^;；,，\s]+)/);
        const codeMatch = text.match(/股票代码\s*[:：]\s*([0-9A-Za-z.\-]+)/);
        let name = nameMatch ? nameMatch[1] : '';
        let code = codeMatch ? codeMatch[1] : '';
        if (!code) {
            const digits = text.match(/\d{6}/);
            if (digits) code = digits[0];
        }
        if (!name && code) {
            const stripped = text.replace(code, '').replace(/股票简称\s*[:：]/, '').replace(/股票代码\s*[:：]/, '').trim();
            name = stripped;
        }
        name = this.normalizeText(name);
        code = this.normalizeStockCode(code);
        if (!name && !code) return null;
        return { '股票简称': name, '股票代码': code };
    }

    private static normalizeStockItem(item: any): StockOcrItem | null {
        if (typeof item === 'string') {
            return this.parseItemFromString(item);
        }
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;

        let name = this.normalizeText(item['股票简称'] ?? item['简称'] ?? item['name'] ?? item['stock_name']);
        let code = this.normalizeText(item['股票代码'] ?? item['代码'] ?? item['symbol'] ?? item['stock_code']);

        if (!code && name) {
            const match = name.match(/\d{6}/);
            if (match) {
                code = match[0];
                name = name.replace(match[0], '').trim();
            }
        }

        code = this.normalizeStockCode(code);
        name = this.normalizeText(name);

        if (!name && !code) return null;
        return { '股票简称': name, '股票代码': code };
    }

    private static normalizeStockList(list: any): StockOcrItem[] {
        if (!Array.isArray(list)) return [];
        const result: StockOcrItem[] = [];
        const seen = new Set<string>();

        for (const item of list) {
            const normalized = this.normalizeStockItem(item);
            if (!normalized) continue;
            const key = normalized['股票代码']
                ? `code:${normalized['股票代码']}`
                : `name:${normalized['股票简称']}`;
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(normalized);
        }

        return result;
    }

    static normalizeImages(inputs: unknown[]): string[] {
        if (!Array.isArray(inputs)) {
            throw new Error('images 必须是数组');
        }
        if (inputs.length === 0) {
            throw new Error('images 不能为空');
        }
        if (inputs.length > this.MAX_IMAGES) {
            throw new Error(`图片数量不能超过 ${this.MAX_IMAGES}`);
        }

        const images: string[] = [];
        const invalid: number[] = [];

        inputs.forEach((input, index) => {
            const url = this.normalizeImage(input);
            if (!url) {
                invalid.push(index);
                return;
            }
            images.push(url);
        });

        if (invalid.length > 0) {
            throw new Error(`images 无效索引: ${invalid.join(',')}`);
        }

        return images;
    }

    private static normalizeImage(input: unknown): string | null {
        if (typeof input === 'string') {
            return this.normalizeImageString(input);
        }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

        const url = (input as any).url;
        const data = (input as any).data;
        const mime = (input as any).mime;

        if (typeof url === 'string') {
            return this.normalizeImageString(url);
        }
        if (typeof data === 'string') {
            return this.buildDataUrl(data, typeof mime === 'string' && mime ? mime : this.DEFAULT_MIME);
        }
        return null;
    }

    private static normalizeImageString(value: string): string | null {
        const trimmed = value.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
        if (trimmed.startsWith('data:')) {
            const match = trimmed.match(/^data:([^;]+);base64,/i);
            const mime = match?.[1] || this.DEFAULT_MIME;
            return this.buildDataUrl(trimmed, mime);
        }
        return this.buildDataUrl(trimmed, this.DEFAULT_MIME);
    }

    private static buildDataUrl(base64: string, mime: string): string | null {
        const cleaned = base64.trim().replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
        if (!cleaned) return null;
        if (cleaned.length > this.MAX_BASE64_CHARS) {
            throw new Error(`单张图片体积过大，base64 长度不能超过 ${this.MAX_BASE64_CHARS}`);
        }
        return `data:${mime};base64,${cleaned}`;
    }

    private static buildPrompt(imageCount: number, hint?: string): string {
        const hintText = hint ? `\n补充信息: ${hint}` : '';
        return `你是股票 OCR 识别助手，请从图片中识别用户自选股列表。\n` +
            `要求:\n` +
            `1. 我会提供 ${imageCount} 张图片，请按顺序输出结果。\n` +
            `2. 输出必须是严格 JSON 数组，长度必须等于图片数量。\n` +
            `3. 每个元素是该图片识别到的股票数组；股票对象仅包含\"股票简称\"和\"股票代码\"。\n` +
            `4. 股票代码必须是字符串，保留前导零。\n` +
            `5. 若无法识别该图片，则返回空数组。\n` +
            `6. 不要输出任何解释文字或 Markdown。` +
            hintText;
    }

    private static sanitizeModelJsonText(raw: string): string {
        const trimmed = raw.trim();
        if (!trimmed) return '';

        if (trimmed.startsWith('```')) {
            const codeBlock = trimmed
                .replace(/^```json\s*/i, '')
                .replace(/^```\s*/i, '')
                .replace(/\s*```$/, '');
            return codeBlock.trim();
        }

        const arrayStart = trimmed.indexOf('[');
        const arrayEnd = trimmed.lastIndexOf(']');
        if (arrayStart >= 0 && arrayEnd > arrayStart) {
            return trimmed.slice(arrayStart, arrayEnd + 1).trim();
        }

        const objStart = trimmed.indexOf('{');
        const objEnd = trimmed.lastIndexOf('}');
        if (objStart >= 0 && objEnd > objStart) {
            return trimmed.slice(objStart, objEnd + 1).trim();
        }

        return trimmed;
    }

    private static parseModelResult(raw: string, imageCount: number): StockOcrItem[][] {
        const jsonText = this.sanitizeModelJsonText(raw);
        let parsed: any;
        try {
            parsed = JSON.parse(jsonText);
        } catch {
            throw new Error('模型返回 JSON 解析失败');
        }

        let payload: any = parsed;
        if (!Array.isArray(payload) && payload && typeof payload === 'object') {
            const candidate = payload.data ?? payload.result ?? payload.results ?? payload['识别结果'];
            if (Array.isArray(candidate)) {
                payload = candidate;
            }
        }

        if (!Array.isArray(payload)) {
            throw new Error('模型返回不是数组');
        }

        let lists: any[] = payload;
        if (payload.length > 0 && payload.every((item: any) => !Array.isArray(item))) {
            lists = [payload];
        }

        const normalized: StockOcrItem[][] = [];
        for (let i = 0; i < imageCount; i++) {
            normalized.push(this.normalizeStockList(lists[i] ?? []));
        }

        return normalized;
    }

    private static async requestModel(prompt: string, imageUrls: string[], env: Env): Promise<string> {
        if (!env.OPENAI_API_BASE_URL) {
            throw new Error('缺少 OPENAI_API_BASE_URL 配置');
        }
        if (!env.OPENAI_API_KEY) {
            throw new Error('缺少 OPENAI_API_KEY 配置');
        }
        if (!env.OCR_MODEL) {
            throw new Error('缺少 OCR_MODEL 配置');
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45_000);

        try {
            const content = [
                { type: 'text', text: prompt },
                ...imageUrls.map(url => ({
                    type: 'image_url',
                    image_url: { url },
                })),
            ];

            const response = await fetch(env.OPENAI_API_BASE_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
                },
                body: JSON.stringify({
                    model: env.OCR_MODEL,
                    temperature: 0,
                    messages: [
                        { role: 'system', content: this.SYSTEM_PROMPT },
                        { role: 'user', content },
                    ],
                }),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`VLM 接口请求失败: ${response.status} ${errText.slice(0, 300)}`);
            }

            const data: any = await response.json();
            const contentText = data?.choices?.[0]?.message?.content;
            if (typeof contentText !== 'string' || !contentText.trim()) {
                throw new Error('VLM 返回内容为空');
            }
            return contentText.trim();
        } finally {
            clearTimeout(timeout);
        }
    }

    private static async generateOcrResult(imageUrls: string[], env: Env, hint?: string): Promise<StockOcrItem[][]> {
        let lastError = '模型输出解析失败';
        const promptBase = this.buildPrompt(imageUrls.length, hint);

        for (let attempt = 1; attempt <= 2; attempt++) {
            const correction = attempt === 1
                ? ''
                : `\n\n【上次输出问题】${lastError}\n请严格修正并仅输出 JSON。`;
            const prompt = promptBase + correction;

            const raw = await this.requestModel(prompt, imageUrls, env);
            try {
                return this.parseModelResult(raw, imageUrls.length);
            } catch (error: any) {
                lastError = error instanceof Error ? error.message : '模型输出解析失败';
            }
        }

        throw new Error(`大模型输出不符合约束: ${lastError}`);
    }

    static async recognizeStocksFromImages(imageUrls: string[], env: Env, hint?: string): Promise<StockOcrItem[][]> {
        if (imageUrls.length === 0) return [];

        const results: StockOcrItem[][] = [];
        for (let i = 0; i < imageUrls.length; i += this.MAX_IMAGES_PER_REQUEST) {
            const batch = imageUrls.slice(i, i + this.MAX_IMAGES_PER_REQUEST);
            const batchResult = await this.generateOcrResult(batch, env, hint);
            results.push(...batchResult);
        }

        return results;
    }
}
