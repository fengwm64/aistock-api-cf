import { formatToChinaTime } from '../utils/datetime';
import { EmQuoteService } from './EmQuoteService';
import { ThsService } from './ThsService';
import { ClsStockNewsService } from './ClsStockNewsService';
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

interface StockAnalysisRow {
    id: number;
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

    private static readonly ANALYSIS_PROMPT_TEMPLATE = `你是一名专业金融分析师，请基于以下信息判断其对该个股的影响。

【分析目标】
综合新闻内容、业绩预测数据以及最近交易数据，判断整体影响。

【结论分类】
只能选择以下五种之一：
- 重大利好
- 利好
- 中性
- 利空
- 重大利空

【判断原则】
1. 新闻的直接影响优先级最高（政策、监管、行业变化、重大合同、业绩爆发等）。
2. 业绩预测数据用于验证新闻是否具备基本面支撑。
3. 最近交易数据用于判断市场是否已经price in。
4. 如果新闻之间存在冲突，需说明权重判断逻辑。
5. 若信息不足或影响有限，应判断为“中性”。

【重大影响标准】
- 重大利好 / 重大利空：可能显著影响未来业绩或估值（>10%利润影响或行业格局改变）。
- 利好 / 利空：短期情绪或边际改善。
- 中性：无明显影响或市场已充分消化。

【引用规则】
- 若在核心逻辑中引用具体新闻，必须使用 Markdown 超链接格式：
  [新闻标题](新闻链接)
- 仅引用真正用于分析判断的新闻。
- 不允许重复引用。
- 不得虚构新闻链接。

【字数要求】
- 核心逻辑必须为 150-250 字。
- 风险提示必须在 150 字以内。

【输入数据】

新闻内容：
{news_text}

业绩预测数据：
{forecast_data}

最近交易数据：
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

    private static buildPrompt(newsText: string, forecastData: string, tradingData: string): string {
        return this.ANALYSIS_PROMPT_TEMPLATE
            .replace('{news_text}', newsText)
            .replace('{forecast_data}', forecastData)
            .replace('{trading_data}', tradingData);
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
                body: JSON.stringify({
                    model: env.EVA_MODEL,
                    temperature: 0.2,
                    messages: [
                        {
                            role: 'system',
                            content: '你是严格的 JSON 输出助手。必须只输出 JSON，不得输出多余解释。',
                        },
                        {
                            role: 'user',
                            content: prompt,
                        },
                    ],
                }),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`大模型接口请求失败: ${response.status} ${errText.slice(0, 300)}`);
            }

            const data: any = await response.json();
            const content = data?.choices?.[0]?.message?.content;
            if (typeof content !== 'string' || !content.trim()) {
                throw new Error('大模型返回内容为空');
            }

            return content.trim();
        } finally {
            clearTimeout(timeout);
        }
    }

    private static async generateStockAnalysis(newsText: string, forecastData: string, tradingData: string, env: Env): Promise<StockAnalysisResult> {
        let lastError = '模型返回格式异常';

        for (let attempt = 1; attempt <= 2; attempt++) {
            const correction = attempt === 1
                ? ''
                : `\n\n【上次输出问题】\n${lastError}\n请严格修正并仅输出 JSON。`;
            const prompt = this.buildPrompt(newsText, forecastData, tradingData) + correction;

            const raw = await this.requestModel(prompt, env);
            const parsed = this.parseModelResult(raw);
            if (!parsed) {
                lastError = 'JSON 结构不符合要求';
                continue;
            }

            const validationError = this.validateModelResult(parsed);
            if (!validationError) {
                return parsed;
            }
            lastError = validationError;
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
            '分析ID': row.id,
            '股票代码': row.symbol,
            '股票简称': row.stock_name || '',
            '分析时间': row.analysis_time,
            '结论': row.conclusion,
            '核心逻辑': row.core_logic,
            '风险提示': row.risk_warning,
        };
    }

    static async createStockAnalysis(symbol: string, env: Env): Promise<Record<string, any>> {
        const stockName = await this.getStockName(symbol, env);
        if (!stockName) {
            throw new Error(`股票代码不存在: ${symbol}`);
        }

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
            : { '错误': tradingResult.reason instanceof Error ? tradingResult.reason.message : '交易数据获取失败' };

        const newsText = this.buildNewsText(newsList);
        const forecastData = forecastSummary || '暂无业绩预测摘要';
        const tradingText = JSON.stringify(tradingData, null, 2);

        const modelResult = await this.generateStockAnalysis(newsText, forecastData, tradingText, env);
        const analysisTime = formatToChinaTime(Date.now());

        const insertResult = await env.DB
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

        const insertedId = Number(insertResult.meta?.last_row_id || 0);
        const row = insertedId > 0
            ? await env.DB
                .prepare(
                    `SELECT a.id, a.symbol, s.name AS stock_name, a.analysis_time, a.conclusion, a.core_logic, a.risk_warning
                     FROM stock_analysis a
                     LEFT JOIN stocks s ON s.symbol = a.symbol
                     WHERE a.id = ?1
                     LIMIT 1`
                )
                .bind(insertedId)
                .first<StockAnalysisRow>()
            : null;

        const mapped = row
            ? this.mapAnalysisRow(row)
            : {
                '分析ID': insertedId || 0,
                '股票代码': symbol,
                '股票简称': stockName,
                '分析时间': analysisTime,
                '结论': modelResult['结论'],
                '核心逻辑': modelResult['核心逻辑'],
                '风险提示': modelResult['风险提示'],
            };

        return {
            '来源': 'AI 股票评价',
            '模型': env.EVA_MODEL,
            ...mapped,
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
                `SELECT a.id, a.symbol, s.name AS stock_name, a.analysis_time, a.conclusion, a.core_logic, a.risk_warning
                 FROM stock_analysis a
                 LEFT JOIN stocks s ON s.symbol = a.symbol
                 WHERE a.symbol = ?1
                 ORDER BY a.id DESC
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
