import { EmQuoteService } from './EmQuoteService';
import { ThsService } from './ThsService';
import { ClsStockNewsService } from './ClsStockNewsService';
import { formatToChinaTime } from '../utils/datetime';
import type { Env } from '../index';

type AnalysisConclusion = '重大利好' | '利好' | '中性' | '利空' | '重大利空';

interface StockNewsDigest {
    title: string;
    time: string;
    summary: string;
    link: string;
}

interface StockAnalysisResult {
    '结论': AnalysisConclusion;
    '核心逻辑': string;
    '风险提示': string;
}

export interface StockAnalysisProgressEvent {
    stage: string;
    message: string;
    at: string;
    meta?: Record<string, unknown>;
}

type StockAnalysisProgressHandler = (event: StockAnalysisProgressEvent) => void;

export interface StockAnalysisModelDeltaEvent {
    attempt: number;
    content: string;
}

type StockAnalysisModelDeltaHandler = (event: StockAnalysisModelDeltaEvent) => void;

interface StockAnalysisRow {
    symbol: string;
    stock_name: string | null;
    analysis_time: string;
    conclusion: AnalysisConclusion;
    core_logic: string;
    risk_warning: string;
}

/**
 * 个股 AI 评价服务
 * 聚合新闻 / 盈利预测 / 交易数据，调用大模型生成结构化结论并写入 D1。
 */
export class StockAnalysisService {
    private static readonly NEWS_LIMIT = 5;
    private static readonly ALLOWED_CONCLUSIONS = new Set<AnalysisConclusion>(['重大利好', '利好', '中性', '利空', '重大利空']);

    private static readonly ANALYSIS_SYSTEM_PROMPT = `你是一名严谨的 A 股投研分析师与风险控制助手。

你必须严格遵守以下规则：
1. 只能输出一个 JSON 对象，不得输出任何解释、前后缀、Markdown 代码块。
2. JSON 仅允许三个字段：结论、核心逻辑、风险提示；不得新增或删除字段。
3. 不得编造事实、数据、新闻标题或新闻链接；仅可使用输入中提供的信息。
4. 结论必须与证据链一致，若证据不足必须体现审慎倾向。
5. 语言应专业、清晰、克制，避免口号式和空泛表达。`;

    private static readonly ANALYSIS_PROMPT_TEMPLATE = `请基于给定信息，评估该个股在 {today} 之后 1-4 周维度的综合影响（情绪、估值与盈利预期）。

【分析目标】
综合新闻、业绩预测和最近交易数据，给出可执行的方向判断。

【结论分类】
只能选择以下五种之一：
- 重大利好
- 利好
- 中性
- 利空
- 重大利空

【判断原则】
1. 优先判断新闻事件的直接冲击（政策、监管、订单、业绩预告、行业供需等）。
2. 用盈利预测验证事件是否具备基本面支撑（预期上修/下修、兑现能力）。
3. 用交易数据判断市场是否已计价（price in）及情绪强弱。
4. 若新闻互相冲突，必须说明主次、时效性与权重依据。
5. 若证据不足或已充分计价，应偏向“中性”。

【重大影响标准】
- 重大利好 / 重大利空：可能显著影响未来业绩或估值（>10%利润影响或行业格局改变）。
- 利好 / 利空：短期情绪或边际改善。
- 中性：无明显影响或市场已充分消化。

【分析框架（核心逻辑必须按此顺序组织）】
1. 新闻驱动：指出最关键的 1-2 条信息及方向性影响。
2. 基本面验证：说明盈利预测是否支持上述判断。
3. 交易面验证：判断资金与价格行为是否已反映预期。
4. 综合结论：给出最终方向判断及主要因果链。

【引用规则】
- 若在核心逻辑中引用具体新闻，必须使用 Markdown 超链接格式，并使用\`\`将新闻标题包裹：
  [\`新闻标题\`](新闻链接)
- 仅引用真正用于分析判断的新闻。
- 不允许重复引用。
- 不得虚构新闻链接。

【写作要求】
- 核心逻辑必须为 350-500 字。
- 风险提示必须在 200 字以内。
- 核心逻辑应尽量包含明确判断词（如“抬升/压制/改善/恶化/已计价”），避免空泛表述。
- 风险提示需给出 2-3 个会导致结论失效或弱化的关键条件。

【输入数据】

相关最新新闻内容：
{news_text}

最新业绩预测数据：
{forecast_data}

最近一个交易日的数据：
{trading_data}

【输出要求】
必须严格以 JSON 格式输出，不得输出任何额外解释文字。
不得添加未定义字段。
所有字段必须填写，不得为空。

JSON 结构如下：
{
  "结论": "",
  "核心逻辑": "",
  "风险提示": ""
}`;

    private static emitProgress(
        onProgress: StockAnalysisProgressHandler | undefined,
        stage: string,
        message: string,
        meta?: Record<string, unknown>,
    ): void {
        if (!onProgress) return;
        try {
            onProgress({
                stage,
                message,
                at: formatToChinaTime(Date.now()),
                ...(meta ? { meta } : {}),
            });
        } catch {
            // 进度回调失败不影响主流程
        }
    }

    private static getErrorMessage(reason: unknown, fallback: string): string {
        if (reason instanceof Error && reason.message) {
            return reason.message;
        }
        return fallback;
    }

    private static normalizeText(value: unknown): string {
        if (typeof value !== 'string') return '';
        return value.trim().replace(/\s+/g, ' ');
    }

    private static clipText(text: string, max: number): string {
        if (!text) return '';
        const chars = Array.from(text);
        if (chars.length <= max) return text;
        return chars.slice(0, max).join('') + '...';
    }

    private static getTodayInChina(): string {
        return formatToChinaTime(Date.now()).slice(0, 10);
    }

    /**
     * 生成中国时区时间（带毫秒），避免同一秒内重复插入触发复合主键冲突
     */
    private static formatToChinaTimeWithMs(timestamp: number): string {
        const date = new Date(timestamp);
        const utc8Time = date.getTime() + (date.getTimezoneOffset() * 60000) + (8 * 3600000);
        const d = new Date(utc8Time);

        const pad2 = (n: number) => n.toString().padStart(2, '0');
        const pad3 = (n: number) => n.toString().padStart(3, '0');

        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
            `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
    }

    private static sanitizeModelJsonText(raw: string): string {
        const trimmed = raw.trim();
        if (!trimmed) return '';

        // 兼容 ```json ... ``` 包裹
        if (trimmed.startsWith('```')) {
            const codeBlock = trimmed.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
            return codeBlock.trim();
        }

        // 兜底提取最外层 JSON 对象
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if (start >= 0 && end > start) {
            return trimmed.slice(start, end + 1).trim();
        }

        return trimmed;
    }

    private static parseModelResult(raw: string): StockAnalysisResult | null {
        try {
            const jsonText = this.sanitizeModelJsonText(raw);
            const parsed = JSON.parse(jsonText);

            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
            const keys = Object.keys(parsed);
            const required = ['结论', '核心逻辑', '风险提示'];

            if (keys.length !== required.length) return null;
            if (!required.every(key => keys.includes(key))) return null;

            const conclusion = this.normalizeText((parsed as any)['结论']) as AnalysisConclusion;
            const coreLogic = this.normalizeText((parsed as any)['核心逻辑']);
            const riskWarning = this.normalizeText((parsed as any)['风险提示']);

            if (!this.ALLOWED_CONCLUSIONS.has(conclusion)) return null;
            if (!coreLogic || !riskWarning) return null;

            return {
                '结论': conclusion,
                '核心逻辑': coreLogic,
                '风险提示': riskWarning,
            };
        } catch {
            return null;
        }
    }

    private static validateModelResult(data: StockAnalysisResult): string | null {
        // 校验核心逻辑中的新闻链接是否重复
        const linkRegex = /\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/g;
        const links: string[] = [];
        let match: RegExpExecArray | null = null;
        while ((match = linkRegex.exec(data['核心逻辑'])) !== null) {
            links.push(match[1]);
        }

        const uniqueLinks = new Set(links);
        if (links.length !== uniqueLinks.size) {
            return '核心逻辑中的新闻链接存在重复引用';
        }

        return null;
    }

    private static async fetchStockNewsDigest(symbol: string, env: Env): Promise<StockNewsDigest[]> {
        const newsResult = await ClsStockNewsService.getStockNews(symbol, env, {
            limit: this.NEWS_LIMIT,
            lastTime: 0,
        });
        const digestList: StockNewsDigest[] = [];
        const seen = new Set<string>();

        for (const item of newsResult.items) {
            const title = this.normalizeText(item.title);
            const summary = this.clipText(this.normalizeText(item.content), 120);
            const time = this.normalizeText(item.time);
            const link = this.normalizeText(item.link);

            if (!title || !time || !summary || !link) continue;

            const dedupeKey = `${title}@@${link}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);

            digestList.push({ title, time, summary, link });
        }

        return digestList;
    }

    private static buildNewsText(newsList: StockNewsDigest[]): string {
        if (newsList.length === 0) {
            return '暂无相关新闻';
        }

        return newsList.map((item, index) => (
            `${index + 1}. 标题: ${item.title}\n` +
            `时间: ${item.time}\n` +
            `摘要: ${item.summary}\n` +
            `链接: ${item.link}`
        )).join('\n\n');
    }

    private static buildPrompt(newsText: string, forecastData: string, tradingData: string, today: string): string {
        return this.ANALYSIS_PROMPT_TEMPLATE
            .replace('{today}', today)
            .replace('{news_text}', newsText)
            .replace('{forecast_data}', forecastData)
            .replace('{trading_data}', tradingData);
    }

    private static extractTextFromModelField(value: unknown): string {
        if (typeof value === 'string') {
            return value;
        }

        if (Array.isArray(value)) {
            return value.map((item: any) => {
                if (typeof item === 'string') return item;
                if (item && typeof item === 'object' && typeof item.text === 'string') return item.text;
                return '';
            }).join('');
        }

        return '';
    }

    private static extractModelFinalContent(data: any): string {
        const choice = data?.choices?.[0];
        if (!choice) return '';

        const messageContent = this.extractTextFromModelField(choice?.message?.content);
        if (messageContent) return messageContent;

        const textContent = this.extractTextFromModelField(choice?.text);
        if (textContent) return textContent;

        return '';
    }

    private static extractModelStreamDelta(data: any): string {
        const choice = data?.choices?.[0];
        if (!choice) return '';

        const deltaContent = this.extractTextFromModelField(choice?.delta?.content);
        if (deltaContent) return deltaContent;

        const messageContent = this.extractTextFromModelField(choice?.message?.content);
        if (messageContent) return messageContent;

        const textContent = this.extractTextFromModelField(choice?.text);
        if (textContent) return textContent;

        return '';
    }

    private static buildModelRequestBody(prompt: string, env: Env, stream: boolean): Record<string, unknown> {
        return {
            model: env.EVA_MODEL,
            temperature: 0.2,
            ...(stream ? { stream: true } : {}),
            messages: [
                {
                    role: 'system',
                    content: this.ANALYSIS_SYSTEM_PROMPT,
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
        };
    }

    private static async requestModel(prompt: string, env: Env): Promise<string> {
        if (!env.OPENAI_API_BASE_URL) {
            throw new Error('缺少 OPENAI_API_BASE_URL 配置');
        }
        if (!env.OPENAI_API_KEY) {
            throw new Error('缺少 OPENAI_API_KEY 配置');
        }
        if (!env.EVA_MODEL) {
            throw new Error('缺少 EVA_MODEL 配置');
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45_000);

        try {
            const response = await fetch(env.OPENAI_API_BASE_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
                },
                body: JSON.stringify(this.buildModelRequestBody(prompt, env, false)),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`大模型接口请求失败: ${response.status} ${errText.slice(0, 300)}`);
            }

            const data: any = await response.json();
            const content = this.extractModelFinalContent(data).trim();
            if (!content) {
                throw new Error('大模型返回内容为空');
            }

            return content;
        } finally {
            clearTimeout(timeout);
        }
    }

    private static async requestModelStream(
        prompt: string,
        env: Env,
        attempt: number,
        onModelDelta: StockAnalysisModelDeltaHandler,
    ): Promise<string> {
        if (!env.OPENAI_API_BASE_URL) {
            throw new Error('缺少 OPENAI_API_BASE_URL 配置');
        }
        if (!env.OPENAI_API_KEY) {
            throw new Error('缺少 OPENAI_API_KEY 配置');
        }
        if (!env.EVA_MODEL) {
            throw new Error('缺少 EVA_MODEL 配置');
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45_000);

        try {
            const response = await fetch(env.OPENAI_API_BASE_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
                },
                body: JSON.stringify(this.buildModelRequestBody(prompt, env, true)),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`大模型接口请求失败: ${response.status} ${errText.slice(0, 300)}`);
            }

            const contentType = (response.headers.get('content-type') || '').toLowerCase();
            if (contentType.includes('application/json')) {
                const data: any = await response.json();
                const content = this.extractModelFinalContent(data).trim();
                if (!content) {
                    throw new Error('大模型流式返回内容为空');
                }
                try {
                    onModelDelta({ attempt, content });
                } catch {
                    // 忽略转发回调异常，不影响主流程
                }
                return content;
            }

            if (!response.body) {
                throw new Error('大模型流式响应体为空');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let fullContent = '';
            let doneReceived = false;

            const emitDelta = (delta: string) => {
                if (!delta) return;
                fullContent += delta;
                try {
                    onModelDelta({ attempt, content: delta });
                } catch {
                    // 忽略转发回调异常，不影响主流程
                }
            };

            const consumePayload = (payload: string) => {
                if (!payload) return;
                if (payload === '[DONE]') {
                    doneReceived = true;
                    return;
                }

                try {
                    const parsed = JSON.parse(payload);
                    const delta = this.extractModelStreamDelta(parsed);
                    if (delta) {
                        emitDelta(delta);
                    }
                } catch {
                    // 兼容非 JSON 行
                }
            };

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                let newlineIndex = buffer.indexOf('\n');
                while (newlineIndex >= 0) {
                    const rawLine = buffer.slice(0, newlineIndex);
                    buffer = buffer.slice(newlineIndex + 1);

                    const line = rawLine.trim();
                    if (line) {
                        if (!line.startsWith(':') && !line.startsWith('event:') && !line.startsWith('id:') && !line.startsWith('retry:')) {
                            if (line.startsWith('data:')) {
                                consumePayload(line.slice(5).trim());
                            } else {
                                consumePayload(line);
                            }
                        }
                    }

                    if (doneReceived) break;
                    newlineIndex = buffer.indexOf('\n');
                }

                if (doneReceived) break;
            }

            const tail = buffer.trim();
            if (!doneReceived && tail) {
                if (tail.startsWith('data:')) {
                    consumePayload(tail.slice(5).trim());
                } else {
                    consumePayload(tail);
                }
            }

            const finalContent = fullContent.trim();
            if (!finalContent) {
                throw new Error('大模型流式返回内容为空');
            }
            return finalContent;
        } finally {
            clearTimeout(timeout);
        }
    }

    private static async generateStockAnalysis(
        newsText: string,
        forecastData: string,
        tradingData: string,
        env: Env,
        onProgress?: StockAnalysisProgressHandler,
        onModelDelta?: StockAnalysisModelDeltaHandler,
    ): Promise<StockAnalysisResult> {
        let lastError = '模型返回格式异常';
        const today = this.getTodayInChina();

        for (let attempt = 1; attempt <= 2; attempt++) {
            this.emitProgress(onProgress, 'model.requesting', `调用模型生成评价（第 ${attempt} 次）`, { attempt });
            const correction = attempt === 1
                ? ''
                : `\n\n【上次输出问题】\n${lastError}\n请严格修正并仅输出 JSON。`;
            const prompt = this.buildPrompt(newsText, forecastData, tradingData, today) + correction;

            const raw = onModelDelta
                ? await this.requestModelStream(prompt, env, attempt, onModelDelta)
                : await this.requestModel(prompt, env);
            this.emitProgress(onProgress, 'model.responded', `模型返回完成（第 ${attempt} 次）`, {
                attempt,
                contentLength: raw.length,
            });
            const parsed = this.parseModelResult(raw);
            if (!parsed) {
                lastError = 'JSON 结构不符合要求';
                if (attempt < 2) {
                    this.emitProgress(onProgress, 'model.retrying', `模型输出解析失败，将重试（第 ${attempt + 1} 次）`, {
                        attempt,
                        reason: lastError,
                    });
                } else {
                    this.emitProgress(onProgress, 'model.failed', '模型输出解析失败，无法生成有效结果', {
                        attempt,
                        reason: lastError,
                    });
                }
                continue;
            }

            const validationError = this.validateModelResult(parsed);
            if (!validationError) {
                return parsed;
            }
            lastError = validationError;
            if (attempt < 2) {
                this.emitProgress(onProgress, 'model.retrying', `模型输出校验失败，将重试（第 ${attempt + 1} 次）`, {
                    attempt,
                    reason: lastError,
                });
            } else {
                this.emitProgress(onProgress, 'model.failed', '模型输出校验失败，无法生成有效结果', {
                    attempt,
                    reason: lastError,
                });
            }
        }

        throw new Error(`大模型输出不符合约束: ${lastError}`);
    }

    private static async getStockName(symbol: string, env: Env): Promise<string> {
        const row = await env.DB
            .prepare('SELECT name FROM stocks WHERE symbol = ?1 LIMIT 1')
            .bind(symbol)
            .first<{ name: string }>();
        return this.normalizeText(row?.name || '');
    }

    private static mapAnalysisRow(row: StockAnalysisRow): Record<string, any> {
        return {
            '股票代码': row.symbol,
            '股票简称': row.stock_name || '',
            '分析时间': row.analysis_time,
            '结论': row.conclusion,
            '核心逻辑': row.core_logic,
            '风险提示': row.risk_warning,
        };
    }

    static async createStockAnalysis(
        symbol: string,
        env: Env,
        onProgress?: StockAnalysisProgressHandler,
        onModelDelta?: StockAnalysisModelDeltaHandler,
    ): Promise<Record<string, any>> {
        this.emitProgress(onProgress, 'start', '开始生成个股评价', { symbol });

        const stockName = await this.getStockName(symbol, env);
        if (!stockName) {
            this.emitProgress(onProgress, 'stock.not_found', '股票代码不存在', { symbol });
            throw new Error(`股票代码不存在: ${symbol}`);
        }

        this.emitProgress(onProgress, 'stock.validated', '股票代码校验通过', {
            symbol,
            stockName,
        });
        this.emitProgress(onProgress, 'inputs.fetching', '开始抓取输入数据（新闻/盈利预测/交易）');

        const [newsResult, forecastResult, tradingResult] = await Promise.allSettled([
            this.fetchStockNewsDigest(symbol, env),
            ThsService.getProfitForecast(symbol),
            EmQuoteService.getQuote(symbol, 'activity'),
        ]);

        const newsList = newsResult.status === 'fulfilled' ? newsResult.value : [];
        const forecastSummary = forecastResult.status === 'fulfilled'
            ? this.normalizeText(forecastResult.value?.['摘要'] || '')
            : '';
        const tradingData = tradingResult.status === 'fulfilled'
            ? tradingResult.value
            : { '错误': this.getErrorMessage(tradingResult.reason, '交易数据获取失败') };

        if (newsResult.status === 'fulfilled') {
            this.emitProgress(onProgress, 'inputs.news.ready', '个股新闻抓取完成', { count: newsList.length });
        } else {
            this.emitProgress(onProgress, 'inputs.news.failed', '个股新闻抓取失败，已降级继续分析', {
                reason: this.getErrorMessage(newsResult.reason, '新闻抓取失败'),
            });
        }

        if (forecastResult.status === 'fulfilled') {
            this.emitProgress(onProgress, 'inputs.forecast.ready', '盈利预测抓取完成', {
                hasSummary: Boolean(forecastSummary),
            });
        } else {
            this.emitProgress(onProgress, 'inputs.forecast.failed', '盈利预测抓取失败，已降级继续分析', {
                reason: this.getErrorMessage(forecastResult.reason, '盈利预测抓取失败'),
            });
        }

        if (tradingResult.status === 'fulfilled') {
            this.emitProgress(onProgress, 'inputs.trading.ready', '交易数据抓取完成');
        } else {
            this.emitProgress(onProgress, 'inputs.trading.failed', '交易数据抓取失败，已降级继续分析', {
                reason: this.getErrorMessage(tradingResult.reason, '交易数据抓取失败'),
            });
        }

        const newsText = this.buildNewsText(newsList);
        const forecastData = forecastSummary || '暂无业绩预测摘要';
        const tradingText = JSON.stringify(tradingData, null, 2);
        this.emitProgress(onProgress, 'analysis.prepared', '分析输入数据准备完成', {
            newsCount: newsList.length,
            hasForecastSummary: Boolean(forecastSummary),
        });

        const modelResult = await this.generateStockAnalysis(
            newsText,
            forecastData,
            tradingText,
            env,
            onProgress,
            onModelDelta,
        );
        const analysisTime = this.formatToChinaTimeWithMs(Date.now());
        this.emitProgress(onProgress, 'db.writing', '开始写入 D1');

        await env.DB
            .prepare(
                `INSERT INTO stock_analysis
                    (symbol, analysis_time, conclusion, core_logic, risk_warning)
                 VALUES
                    (?1, ?2, ?3, ?4, ?5)`
            )
            .bind(
                symbol,
                analysisTime,
                modelResult['结论'],
                modelResult['核心逻辑'],
                modelResult['风险提示'],
            )
            .run();

        this.emitProgress(onProgress, 'completed', '个股评价生成完成', {
            symbol,
            analysisTime,
            conclusion: modelResult['结论'],
        });

        return {
            '来源': 'AI 股票评价',
            '模型': env.EVA_MODEL,
            '股票代码': symbol,
            '股票简称': stockName,
            '分析时间': analysisTime,
            '结论': modelResult['结论'],
            '核心逻辑': modelResult['核心逻辑'],
            '风险提示': modelResult['风险提示'],
            '输入摘要': {
                '新闻数量': newsList.length,
                '业绩预测摘要': forecastData,
                '交易数据': tradingData,
            },
        };
    }

    static async getLatestStockAnalysis(symbol: string, env: Env): Promise<Record<string, any> | null> {
        const row = await env.DB
            .prepare(
                `SELECT a.symbol, s.name AS stock_name, a.analysis_time, a.conclusion, a.core_logic, a.risk_warning
                 FROM stock_analysis a
                 LEFT JOIN stocks s ON s.symbol = a.symbol
                 WHERE a.symbol = ?1
                 ORDER BY a.analysis_time DESC
                 LIMIT 1`
            )
            .bind(symbol)
            .first<StockAnalysisRow>();

        if (!row) return null;

        return {
            '来源': 'D1 历史分析',
            ...this.mapAnalysisRow(row),
        };
    }
}
