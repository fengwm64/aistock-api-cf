import { createResponse } from '../utils/response';
import { formatToChinaTime } from '../utils/datetime';
import { Env } from '../index';

/**
 * 财联社新闻控制器
 */
export class NewsController {
    /** 财联社深度首页 API */
    private static readonly BASE_URL = 'https://www.cls.cn/v3/depth/home/assembled/1000';
    
    /** 固定签名 */
    private static readonly SIGN = '9f8797a1f4de66c2370f7a03990d2737';

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
     * 获取头条新闻（最新 5 条）
     */
    static async getHeadlines(env: Env, ctx: ExecutionContext) {
        const url = new URL(this.BASE_URL);
        url.searchParams.set('app', 'CailianpressWeb');
        url.searchParams.set('os', 'web');
        url.searchParams.set('sv', '8.4.6');
        url.searchParams.set('sign', this.SIGN);

        try {
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

            const articles = data.data?.top_article || [];
            
            // 只取前 5 条
            const topArticles = articles.slice(0, 5).map((article: any) => {
                const link = this.extractNewsLink(article.schema || '');
                
                return {
                    '时间': formatToChinaTime(article.ctime * 1000), // Unix 秒转毫秒
                    '标题': (article.title || '').trim(),
                    '摘要': (article.brief || '').trim(),
                    '作者': (article.author || '').trim(),
                    '链接': link,
                };
            });

            return createResponse(200, 'success', {
                '来源': '财联社',
                '更新时间': formatToChinaTime(Date.now()),
                '新闻数量': topArticles.length,
                '头条新闻': topArticles,
            });
        } catch (error: any) {
            return createResponse(500, error.message);
        }
    }
}
