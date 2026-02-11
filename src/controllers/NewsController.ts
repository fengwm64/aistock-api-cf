import { createResponse } from '../utils/response';
import { formatToChinaTime } from '../utils/datetime';
import { Env } from '../index';
import * as cheerio from 'cheerio';
import { cailianpressThrottler } from '../utils/throttlers';

/**
 * 财联社新闻控制器
 */
export class NewsController {
    /** 财联社深度首页 API 基础 URL */
    private static readonly BASE_URL = 'https://www.cls.cn/v3/depth/home/assembled';
    /** 财联社个股新闻检索 API */
    private static readonly STOCK_NEWS_URL = 'https://www.cls.cn/api/csw?app=CailianpressWeb&os=web&sv=8.4.6&sign=9f8797a1f4de66c2370f7a03990d2737';
    /** 财联社个股新闻请求头 */
    private static readonly STOCK_NEWS_HEADERS = {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'Origin': 'https://www.cls.cn',
        'Referer': 'https://www.cls.cn/telegraph',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    };
    /** 个股新闻默认返回条数 */
    private static readonly STOCK_NEWS_DEFAULT_LIMIT = 8;
    /** 个股新闻最大返回条数 */
    private static readonly STOCK_NEWS_MAX_LIMIT = 50;
    /** 用于去除内容开头的【...】前缀 */
    private static readonly BRACKET_PREFIX_PATTERN = /^【[^】]*】/;
    
    /** 固定签名 */
    private static readonly SIGN = '9f8797a1f4de66c2370f7a03990d2737';

    /**
     * 将财联社时间戳格式化为中国时间（兼容秒/毫秒）
     */
    private static formatClsTimestamp(timestamp: unknown): string {
        if (timestamp === null || timestamp === undefined) return '';
        const tsNumber = Number(timestamp);
        if (!Number.isFinite(tsNumber)) return '';
        const ms = tsNumber < 1_000_000_000_000 ? tsNumber * 1000 : tsNumber;
        return formatToChinaTime(ms);
    }

    /**
     * 解析时间戳为 Unix 秒（兼容秒/毫秒）
     */
    private static parseTimestampSeconds(timestamp: unknown): number | null {
        if (timestamp === null || timestamp === undefined) return null;
        const tsNumber = Number(timestamp);
        if (!Number.isFinite(tsNumber)) return null;
        return tsNumber >= 1_000_000_000_000 ? Math.floor(tsNumber / 1000) : Math.floor(tsNumber);
    }

    /**
     * 移除 HTML 标签、解码实体，并剔除开头【...】前缀
     */
    private static stripHtml(rawHtml: unknown): string {
        if (typeof rawHtml !== 'string' || !rawHtml.trim()) return '';
        const text = cheerio.load(rawHtml).text().trim();
        return text.replace(this.BRACKET_PREFIX_PATTERN, '').trim();
    }

    /**
     * 从电报 HTML 内容中提取标题与正文
     */
    private static extractTelegraphTitleAndContent(rawHtml: unknown): { title: string; content: string } {
        if (typeof rawHtml !== 'string' || !rawHtml.trim()) {
            return { title: '', content: '' };
        }

        const $ = cheerio.load(rawHtml);
        const title = ($('.detail-header').first().text() || '').trim();
        const content = ($('.detail-telegraph-content').first().text() || '').trim();

        return {
            title: title.replace(this.BRACKET_PREFIX_PATTERN, '').trim(),
            content: content.replace(this.BRACKET_PREFIX_PATTERN, '').trim(),
        };
    }

    /**
     * 从财联社接口响应中提取列表和总数
     */
    private static extractStockNewsEntries(payload: any): { entries: any[]; total: number | null } {
        if (payload && typeof payload === 'object') {
            if (Array.isArray(payload.list)) {
                let total: number | null = null;
                if (typeof payload.total === 'number' && Number.isFinite(payload.total)) {
                    total = payload.total;
                } else if (typeof payload.total === 'string' && /^\d+$/.test(payload.total)) {
                    total = Number(payload.total);
                }
                return { entries: payload.list, total };
            }
            if ('data' in payload) {
                return this.extractStockNewsEntries(payload.data);
            }
        }
        return { entries: [], total: null };
    }

    /**
     * 从 D1 中查股票简称，作为财联社检索关键词（若失败则退化为 symbol）
     */
    private static async resolveStockKeyword(symbol: string, env: Env): Promise<{ keyword: string; stockName: string }> {
        try {
            const row = await env.DB
                .prepare('SELECT name FROM stocks WHERE symbol = ? LIMIT 1')
                .bind(symbol)
                .first<{ name: string }>();

            const stockName = (row?.name || '').trim();
            return {
                keyword: stockName || symbol,
                stockName,
            };
        } catch {
            return {
                keyword: symbol,
                stockName: '',
            };
        }
    }

    /**
     * 从 schema 中提取新闻链接
     * schema 格式: "cailianshe://article_detail?article_id=2285089"
     */
    private static extractNewsLink(schema: string): string {
        if (!schema) return '';
        
        // 提取 article_id= 后的 ID
        const match = schema.match(/article_id=(\d+)/);
        if (match && match[1]) {
            return `https://www.cls.cn/detail/${match[1]}`;
        }
        
        return '';
    }

    /**
     * 通用获取新闻方法
     * @param categoryId 分类 ID
     * @param categoryName 分类名称
     */
    private static async fetchNews(categoryId: number, categoryName: string): Promise<Response> {
        const url = new URL(`${this.BASE_URL}/${categoryId}`);
        url.searchParams.set('app', 'CailianpressWeb');
        url.searchParams.set('os', 'web');
        url.searchParams.set('sv', '8.4.6');
        url.searchParams.set('sign', this.SIGN);

        try {
            // 限流 (财联社)
            await cailianpressThrottler.throttle();

            const response = await fetch(url.toString(), {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                    'Accept': 'application/json',
                    'Referer': 'https://www.cls.cn/',
                },
            });

            if (!response.ok) {
                throw new Error(`财联社接口请求失败: ${response.status}`);
            }

            const data: any = await response.json();

            if (data.errno !== 0) {
                throw new Error(`财联社接口返回错误: ${data.msg || 'Unknown error'}`);
            }

            let articles = data.data?.top_article || [];
            
            // 如果 top_article 不足 5 条，从 depth_list 补充
            if (articles.length < 5) {
                const depthList = data.data?.depth_list || [];
                const needed = 5 - articles.length;
                articles = [...articles, ...depthList.slice(0, needed)];
            }
            
            // 只取前 5 条
            const topArticles = articles.slice(0, 5).map((article: any) => {
                const link = article.id ? `https://www.cls.cn/detail/${article.id}` : '';
                
                return {
                    'ID': article.id || '',
                    '时间': formatToChinaTime(article.ctime * 1000), // Unix 秒转毫秒
                    '标题': (article.title || '').trim(),
                    '摘要': (article.brief || '').trim(),
                    '作者': (article.author || article.source || '').trim(),
                    '标签': [],
                    '链接': link,
                };
            });

            return createResponse(200, 'success', {
                '来源': '财联社',
                '分类': categoryName,
                '更新时间': formatToChinaTime(Date.now()),
                '新闻数量': topArticles.length,
                '头条新闻': topArticles,
            });
        } catch (error: any) {
            return createResponse(500, error.message);
        }
    }

    /**
     * 获取头条新闻（最新 5 条）
     */
    static async getHeadlines(env: Env, ctx: ExecutionContext) {
        return this.fetchNews(1000, '头条新闻');
    }

    /**
     * 获取 A 股市场新闻
     */
    static async getCnNews(env: Env, ctx: ExecutionContext) {
        return this.fetchNews(1003, 'A股市场');
    }

    /**
     * 获取港股市场新闻
     */
    static async getHkNews(env: Env, ctx: ExecutionContext) {
        return this.fetchNews(1135, '港股市场');
    }

    /**
     * 获取环球新闻
     */
    static async getGlobalNews(env: Env, ctx: ExecutionContext) {
        return this.fetchNews(1007, '环球');
    }

    /**
     * 获取基金/ETF 新闻
     */
    static async getFundNews(env: Env, ctx: ExecutionContext) {
        return this.fetchNews(1110, '基金/ETF');
    }

    /**
     * 获取个股相关新闻
     * 路径: GET /api/cn/stocks/:symbol/news
     * 参数:
     * - limit: 返回条数（1-50，默认20）
     * - lastTime: 翻页时间戳（Unix 秒，默认0）
     */
    static async getStockNews(symbol: string, request: Request, env: Env, ctx: ExecutionContext) {
        if (!symbol || !/^\d{6}$/.test(symbol)) {
            return createResponse(400, 'Invalid symbol - A股代码必须是6位数字');
        }

        const url = new URL(request.url);
        const limitParam = url.searchParams.get('limit');
        const lastTimeParam = url.searchParams.get('lastTime');

        let limit = this.STOCK_NEWS_DEFAULT_LIMIT;
        if (limitParam !== null) {
            const parsedLimit = Number(limitParam);
            if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > this.STOCK_NEWS_MAX_LIMIT) {
                return createResponse(400, `Invalid limit - limit 必须是 1-${this.STOCK_NEWS_MAX_LIMIT} 的整数`);
            }
            limit = parsedLimit;
        }

        let lastTime = 0;
        if (lastTimeParam !== null) {
            const parsedLastTime = Number(lastTimeParam);
            if (!Number.isInteger(parsedLastTime) || parsedLastTime < 0) {
                return createResponse(400, 'Invalid lastTime - lastTime 必须是大于等于0的整数');
            }
            lastTime = parsedLastTime;
        }

        try {
            const { keyword, stockName } = await this.resolveStockKeyword(symbol, env);
            const payload = {
                'lastTime': lastTime,
                'keyword': keyword,
                'category': '',
                'os': 'web',
                'sv': '8.4.6',
                'app': 'CailianpressWeb',
            };

            // 限流 (财联社)
            await cailianpressThrottler.throttle();

            const response = await fetch(this.STOCK_NEWS_URL, {
                method: 'POST',
                headers: this.STOCK_NEWS_HEADERS,
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                throw new Error(`财联社个股新闻接口请求失败: ${response.status}`);
            }

            let rawData: any = null;
            try {
                rawData = await response.json();
            } catch {
                throw new Error('Failed to decode JSON response');
            }

            if (typeof rawData?.errno === 'number' && rawData.errno !== 0) {
                throw new Error(`财联社接口返回错误: ${rawData.msg || 'Unknown error'}`);
            }

            const { entries, total } = this.extractStockNewsEntries(rawData);
            const normalizedItems: Record<string, any>[] = [];

            for (const entry of entries) {
                if (!entry || typeof entry !== 'object') continue;
                const entryCtimeSec = this.parseTimestampSeconds(entry.ctime);
                // 与 limit 取交集：先按 lastTime 过滤，再限制条数
                if (entryCtimeSec === null || entryCtimeSec < lastTime) {
                    continue;
                }

                const entryId = entry.id;
                const parsedFromHtml = this.extractTelegraphTitleAndContent(entry.content);
                const title = (typeof entry.title === 'string' ? entry.title.trim() : '') || parsedFromHtml.title;
                const content = parsedFromHtml.content || this.stripHtml(entry.content);

                normalizedItems.push({
                    'ID': entryId || '',
                    '链接': entryId ? `https://www.cls.cn/detail/${entryId}` : '',
                    '标题': title,
                    '时间': this.formatClsTimestamp(entry.ctime),
                    '内容': content,
                });

                if (normalizedItems.length >= limit) {
                    break;
                }
            }

            return createResponse(200, 'success', {
                '来源': '财联社',
                '股票代码': symbol,
                '股票简称': stockName,
                '查询关键词': keyword,
                '更新时间': formatToChinaTime(Date.now()),
                'lastTime': lastTime,
                '新闻数量': normalizedItems.length,
                '总数量': total ?? normalizedItems.length,
                '个股新闻': normalizedItems,
            });
        } catch (error: any) {
            return createResponse(500, error.message);
        }
    }

    /**
     * 获取新闻详情（含全文）
     * @param id 新闻 ID
     */
    static async getNewsDetail(id: string, env: Env, ctx: ExecutionContext) {
        if (!id || !/^\d+$/.test(id)) {
            return createResponse(400, '无效的新闻 ID');
        }

        const url = `https://www.cls.cn/detail/${id}`;

        try {
            // 限流 (财联社)
            await cailianpressThrottler.throttle();

            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                },
            });

            if (!response.ok) {
                throw new Error(`财联社新闻页面请求失败: ${response.status}`);
            }

            const html = await response.text();
            
            // 剥离 script/style 提升性能
            const cleanHtml = html
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<!--[\s\S]*?-->/g, '');

            const $ = cheerio.load(cleanHtml, { scriptingEnabled: false });

            // 提取标题（支持两种格式）
            let title = '';
            // 格式1: 标准详情页
            $('.detail-title span').each((_, elem) => {
                title = $(elem).text().trim();
                return false;
            });
            // 格式2: 电报快讯页
            if (!title) {
                $('.detail-header').each((_, elem) => {
                    title = $(elem).text().trim();
                    return false;
                });
            }

            // 提取时间
            let publishTime = '';
            const normalizePublishTime = (raw: string): string => {
                if (!raw) return '';

                const trimmed = raw.trim();

                // Unix 时间戳格式
                if (/^\d{10,13}$/.test(trimmed)) {
                    const timestamp = Number(trimmed);
                    const ms = trimmed.length === 10 ? timestamp * 1000 : timestamp;
                    return formatToChinaTime(ms);
                }

                // 清理格式：去掉星期、年月日等中文字符，统一为 YYYY-MM-DD HH:mm 格式
                const normalized = trimmed
                    .replace(/\s*星期[一二三四五六日天]\s*/g, ' ')
                    .replace(/年|\//g, '-')
                    .replace(/月/g, '-')
                    .replace(/日/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();

                // 匹配 YYYY-MM-DD HH:mm 或 YYYY-MM-DD HH:mm:ss 格式
                // 这些时间已经是中国时间，不需要再做时区转换
                const dateTimeMatch = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
                if (dateTimeMatch) {
                    const [, year, month, day, hour, minute, second] = dateTimeMatch;
                    const pad = (n: string) => n.padStart(2, '0');
                    return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second || '00')}`;
                }

                return trimmed;
            };

            const timeCandidates = [
                $('.m-b-20.f-s-14.l-h-2.c-999.clearfix .f-l.m-r-10').first().text(),
                $('.detail-time').first().text(),
                $('[class*="detail-time"]').first().text(),
                $('time').first().attr('datetime') || $('time').first().text(),
                $('meta[property="article:published_time"]').attr('content'),
                $('meta[name="pubdate"]').attr('content'),
            ]
                .map(value => (value || '').trim())
                .filter(Boolean);

            if (timeCandidates.length > 0) {
                publishTime = normalizePublishTime(timeCandidates[0]);
            }

            // 查找包含 detail-brief 的元素（摘要）
            let brief = '';
            $('[class*="detail-brief"]').each((_, elem) => {
                const text = $(elem).text().trim();
                // 去除【】包裹的内容
                brief = text.replace(/【[^】]*】/g, '').trim();
                return false; // 找到第一个即停止
            });

            // 查找详细内容（支持两种格式，保留HTML格式）
            let content = '';
            
            // 格式1: 标准详情页
            $('.detail-content').each((_, elem) => {
                let htmlContent = $(elem).html() || '';
                htmlContent = htmlContent.replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '');
                htmlContent = htmlContent.replace(/\n\s*\n/g, '\n').trim();
                content = htmlContent;
                return false;
            });

            // 格式2: 电报快讯页
            if (!content) {
                const telegraphContent = $('.detail-telegraph-content').first();
                const telegraphImages = $('.telegraph-images-box img');
                
                if (telegraphContent.length > 0) {
                    let htmlContent = '';
                    
                    // 添加正文内容
                    const textContent = telegraphContent.html() || '';
                    if (textContent) {
                        htmlContent += textContent;
                    }
                    
                    // 添加图片
                    if (telegraphImages.length > 0) {
                        telegraphImages.each((_, img) => {
                            const src = $(img).attr('src');
                            if (src) {
                                htmlContent += `\n<p><img src="${src}" alt="image"></p>`;
                            }
                        });
                    }
                    
                    content = htmlContent.trim();
                }
            }

            if (!title && !brief && !content) {
                return createResponse(404, '未找到新闻内容');
            }

            return createResponse(200, 'success', {
                'ID': id,
                '链接': url,
                '时间': publishTime,
                '标题': title,
                '摘要': brief,
                '标签': [],
                '正文': content,
            });
        } catch (error: any) {
            return createResponse(500, error.message);
        }
    }
}
