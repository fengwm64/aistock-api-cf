import type { Env } from '../index';

export interface StockOcrItem {
    '股票简称': string;
    '股票代码': string;
}

interface StockLookupRow {
    symbol: string;
    name: string;
}

export interface StockOcrOptions {
    batchConcurrency?: number;
    maxImagesPerRequest?: number;
    timeoutMs?: number;
}

interface ResolvedStockOcrOptions {
    batchConcurrency: number;
    maxImagesPerRequest: number;
    timeoutMs: number;
}

export class StockOcrService {
    private static readonly MAX_IMAGES = 8;
    private static readonly MAX_IMAGES_PER_REQUEST = 4;
    private static readonly MAX_BATCH_CONCURRENCY = 4;
    private static readonly MAX_CODES_PER_QUERY = 200;
    private static readonly MAX_NAMES_PER_QUERY = 200;
    private static readonly MAX_NAME_LOOKUP_CONCURRENCY = 4;
    private static readonly MAX_BASE64_CHARS = 6_000_000;
    private static readonly DEFAULT_MIME = 'image/png';
    private static readonly DEFAULT_BATCH_CONCURRENCY = 2;
    private static readonly DEFAULT_TIMEOUT_MS = 45_000;
    private static readonly MIN_TIMEOUT_MS = 10_000;
    private static readonly MAX_TIMEOUT_MS = 120_000;

    private static readonly SYSTEM_PROMPT = '你是严格的 JSON 输出助手。必须只输出 JSON，不得输出多余解释。';

    private static normalizeText(value: unknown): string {
        if (typeof value !== 'string') return '';
        return value.trim().replace(/\s+/g, ' ');
    }

    private static clampInteger(value: unknown, min: number, max: number, fallback: number): number {
        const parsed = typeof value === 'number'
            ? value
            : (typeof value === 'string' && value.trim() ? Number(value) : NaN);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(max, Math.max(min, Math.floor(parsed)));
    }

    private static resolveOptions(options?: StockOcrOptions): ResolvedStockOcrOptions {
        return {
            batchConcurrency: this.clampInteger(
                options?.batchConcurrency,
                1,
                this.MAX_BATCH_CONCURRENCY,
                this.DEFAULT_BATCH_CONCURRENCY,
            ),
            maxImagesPerRequest: this.clampInteger(
                options?.maxImagesPerRequest,
                1,
                this.MAX_IMAGES_PER_REQUEST,
                this.MAX_IMAGES_PER_REQUEST,
            ),
            timeoutMs: this.clampInteger(
                options?.timeoutMs,
                this.MIN_TIMEOUT_MS,
                this.MAX_TIMEOUT_MS,
                this.DEFAULT_TIMEOUT_MS,
            ),
        };
    }

    private static normalizeStockCode(raw: string): string {
        const cleaned = raw.trim();
        if (!cleaned) return '';
        const match = cleaned.match(/\d{6}/);
        if (match) return match[0];
        return cleaned.replace(/\s+/g, '').toUpperCase();
    }

    private static isValidStockCode(code: string): boolean {
        return /^\d{6}$/.test(code);
    }

    private static escapeLike(value: string): string {
        return value
            .replace(/\\/g, '\\\\')
            .replace(/%/g, '\\%')
            .replace(/_/g, '\\_');
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

    private static extractUniqueCodes(recognized: StockOcrItem[][]): string[] {
        const codes = new Set<string>();
        for (const list of recognized) {
            for (const item of list) {
                const code = this.normalizeStockCode(item['股票代码']);
                if (this.isValidStockCode(code)) {
                    codes.add(code);
                }
            }
        }
        return Array.from(codes);
    }

    private static async fetchStocksByCodes(codes: string[], env: Env): Promise<Map<string, StockLookupRow>> {
        const result = new Map<string, StockLookupRow>();
        if (codes.length === 0) return result;

        for (let i = 0; i < codes.length; i += this.MAX_CODES_PER_QUERY) {
            const chunk = codes.slice(i, i + this.MAX_CODES_PER_QUERY);
            if (chunk.length === 0) continue;

            const placeholders = chunk.map(() => '?').join(',');
            const sql = `SELECT symbol, name FROM stocks WHERE symbol IN (${placeholders})`;
            const queryResult = await env.DB.prepare(sql).bind(...chunk).all<StockLookupRow>();

            for (const row of queryResult.results || []) {
                const symbol = this.normalizeStockCode(row.symbol);
                if (!this.isValidStockCode(symbol)) continue;
                result.set(symbol, {
                    symbol,
                    name: this.normalizeText(row.name),
                });
            }
        }

        return result;
    }

    private static async fetchStocksByExactNames(names: string[], env: Env): Promise<Map<string, StockLookupRow>> {
        const result = new Map<string, StockLookupRow>();
        if (names.length === 0) return result;

        for (let i = 0; i < names.length; i += this.MAX_NAMES_PER_QUERY) {
            const chunk = names.slice(i, i + this.MAX_NAMES_PER_QUERY);
            if (chunk.length === 0) continue;

            const placeholders = chunk.map(() => '?').join(',');
            const sql = `SELECT symbol, name FROM stocks WHERE name IN (${placeholders}) ORDER BY symbol`;
            const queryResult = await env.DB.prepare(sql).bind(...chunk).all<StockLookupRow>();

            for (const row of queryResult.results || []) {
                const normalizedName = this.normalizeText(row.name);
                const symbol = this.normalizeStockCode(row.symbol);
                if (!normalizedName || !this.isValidStockCode(symbol)) continue;
                if (!result.has(normalizedName)) {
                    result.set(normalizedName, {
                        symbol,
                        name: normalizedName,
                    });
                }
            }
        }

        return result;
    }

    private static async fuzzyFindStockByName(name: string, env: Env): Promise<StockLookupRow | null> {
        const normalizedName = this.normalizeText(name);
        if (!normalizedName) return null;

        const pattern = `%${this.escapeLike(normalizedName)}%`;
        const row = await env.DB
            .prepare("SELECT symbol, name FROM stocks WHERE name LIKE ?1 ESCAPE '\\' OR pinyin LIKE ?1 ESCAPE '\\' ORDER BY symbol LIMIT 1")
            .bind(pattern)
            .first<StockLookupRow>();

        if (!row) return null;

        const symbol = this.normalizeStockCode(row.symbol);
        if (!this.isValidStockCode(symbol)) return null;

        return {
            symbol,
            name: this.normalizeText(row.name),
        };
    }

    private static async resolveNameLookups(names: string[], env: Env): Promise<Map<string, StockLookupRow | null>> {
        const normalizedNames = Array.from(new Set(
            names
                .map(name => this.normalizeText(name))
                .filter(Boolean),
        ));

        const result = new Map<string, StockLookupRow | null>();
        if (normalizedNames.length === 0) return result;

        const exactMap = await this.fetchStocksByExactNames(normalizedNames, env);
        for (const name of normalizedNames) {
            result.set(name, exactMap.get(name) || null);
        }

        const unresolved = normalizedNames.filter(name => !exactMap.has(name));
        if (unresolved.length === 0) return result;

        const jobs = unresolved.map((name) => async () => ({
            name,
            row: await this.fuzzyFindStockByName(name, env),
        }));
        const fuzzyResults = await this.runWithConcurrency(jobs, this.MAX_NAME_LOOKUP_CONCURRENCY);

        for (const item of fuzzyResults) {
            result.set(item.name, item.row);
        }

        return result;
    }

    private static async normalizeByStocks(recognized: StockOcrItem[][], env: Env): Promise<StockOcrItem[][]> {
        const allCodes = this.extractUniqueCodes(recognized);
        const codeMap = await this.fetchStocksByCodes(allCodes, env);
        const namesToResolve: string[] = [];

        for (const list of recognized) {
            for (const item of list) {
                const rawName = this.normalizeText(item['股票简称']);
                const rawCode = this.normalizeStockCode(item['股票代码']);
                const hasCode = this.isValidStockCode(rawCode);
                if (!rawName) continue;
                if (!hasCode || !codeMap.has(rawCode)) {
                    namesToResolve.push(rawName);
                }
            }
        }

        const nameLookupMap = await this.resolveNameLookups(namesToResolve, env);

        const output: StockOcrItem[][] = [];
        for (const list of recognized) {
            const normalizedList: StockOcrItem[] = [];
            const seen = new Set<string>();

            for (const item of list) {
                const rawName = this.normalizeText(item['股票简称']);
                const rawCode = this.normalizeStockCode(item['股票代码']);

                let finalName = rawName;
                let finalCode = this.isValidStockCode(rawCode) ? rawCode : '';

                if (finalCode) {
                    const byCode = codeMap.get(finalCode);
                    if (byCode) {
                        // 强制使用数据库标准名称覆盖 OCR 名称
                        finalName = byCode.name;
                    } else if (rawName) {
                        const byName = nameLookupMap.get(rawName) || null;
                        if (byName) {
                            finalCode = byName.symbol;
                            finalName = byName.name;
                        }
                    }
                } else if (rawName) {
                    const byName = nameLookupMap.get(rawName) || null;
                    if (byName) {
                        finalCode = byName.symbol;
                        finalName = byName.name;
                    }
                } else {
                    continue;
                }

                const safeName = this.normalizeText(finalName);
                const safeCode = this.normalizeStockCode(finalCode);
                if (!safeName && !safeCode) continue;

                const key = safeCode ? `code:${safeCode}` : `name:${safeName}`;
                if (seen.has(key)) continue;
                seen.add(key);

                normalizedList.push({
                    '股票简称': safeName,
                    '股票代码': safeCode,
                });
            }

            output.push(normalizedList);
        }

        return output;
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

    private static buildImageMessage(url: string): Record<string, any> {
        return {
            type: 'image_url',
            image_url: { url },
        };
    }

    private static async requestModel(prompt: string, imageUrls: string[], env: Env, options: ResolvedStockOcrOptions): Promise<string> {
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
        const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

        try {
            const content = [
                { type: 'text', text: prompt },
                ...imageUrls.map(url => this.buildImageMessage(url)),
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

    private static async generateOcrResult(imageUrls: string[], env: Env, hint: string | undefined, options: ResolvedStockOcrOptions): Promise<StockOcrItem[][]> {
        let lastError = '模型输出解析失败';
        const promptBase = this.buildPrompt(imageUrls.length, hint);

        for (let attempt = 1; attempt <= 2; attempt++) {
            const correction = attempt === 1
                ? ''
                : `\n\n【上次输出问题】${lastError}\n请严格修正并仅输出 JSON。`;
            const prompt = promptBase + correction;

            const raw = await this.requestModel(prompt, imageUrls, env, options);
            try {
                return this.parseModelResult(raw, imageUrls.length);
            } catch (error: any) {
                lastError = error instanceof Error ? error.message : '模型输出解析失败';
            }
        }

        throw new Error(`大模型输出不符合约束: ${lastError}`);
    }

    private static splitIntoBatches(imageUrls: string[], batchSize: number): string[][] {
        const batches: string[][] = [];
        for (let i = 0; i < imageUrls.length; i += batchSize) {
            batches.push(imageUrls.slice(i, i + batchSize));
        }
        return batches;
    }

    private static async runWithConcurrency<T>(jobs: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
        const results: T[] = new Array(jobs.length);
        let cursor = 0;
        const workerCount = Math.min(concurrency, jobs.length);

        const workers = Array.from({ length: workerCount }, async () => {
            while (true) {
                const index = cursor;
                cursor += 1;
                if (index >= jobs.length) break;
                results[index] = await jobs[index]();
            }
        });

        await Promise.all(workers);
        return results;
    }

    private static async runRecognition(
        imageUrls: string[],
        env: Env,
        hint: string | undefined,
        resolved: ResolvedStockOcrOptions,
    ): Promise<StockOcrItem[][]> {
        const batches = this.splitIntoBatches(imageUrls, resolved.maxImagesPerRequest);
        const jobs = batches.map((batch) => async () => this.generateOcrResult(batch, env, hint, resolved));
        const batchResults = await this.runWithConcurrency(jobs, resolved.batchConcurrency);
        const recognized = batchResults.flat();
        return this.normalizeByStocks(recognized, env);
    }

    static async recognizeStocksFromImages(imageUrls: string[], env: Env, hint?: string, options?: StockOcrOptions): Promise<StockOcrItem[][]> {
        if (imageUrls.length === 0) return [];

        const resolved = this.resolveOptions(options);
        return this.runRecognition(imageUrls, env, hint, resolved);
    }
}
