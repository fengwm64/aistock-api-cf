import { createResponse } from '../utils/response';
import { Env } from '../index';

/**
 * A股列表控制器
 */
export class StockListController {
    /** 默认每页数量 */
    private static readonly DEFAULT_PAGE_SIZE = 50;
    /** 最大每页数量 */
    private static readonly MAX_PAGE_SIZE = 500;

    /**
     * 统一股票查询接口
     * 支持全量分页、关键词搜索、精确查询、组合筛选
     * 使用 D1 Sessions API 实现读复制以降低延迟
     */
    static async getStockList(request: Request, env: Env, ctx: ExecutionContext) {
        const url = new URL(request.url);
        const pageParam = url.searchParams.get('page');
        const pageSizeParam = url.searchParams.get('pageSize');
        const keyword = url.searchParams.get('keyword')?.trim();
        const symbol = url.searchParams.get('symbol')?.trim();
        const market = url.searchParams.get('market')?.trim()?.toUpperCase();

        // 解析页码，默认第1页
        let page = 1;
        if (pageParam) {
            const parsed = Number(pageParam);
            if (!Number.isInteger(parsed) || parsed < 1) {
                return createResponse(400, 'Invalid page - page 必须是大于0的整数');
            }
            page = parsed;
        }

        // 解析每页数量，默认50
        let pageSize = this.DEFAULT_PAGE_SIZE;
        if (pageSizeParam) {
            const parsed = Number(pageSizeParam);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > this.MAX_PAGE_SIZE) {
                return createResponse(400, `Invalid pageSize - pageSize 必须是 1-${this.MAX_PAGE_SIZE} 的整数`);
            }
            pageSize = parsed;
        }

        // 验证参数长度
        if (symbol && symbol.length > 8) {
            return createResponse(400, 'symbol 长度不能超过8个字符');
        }
        if (keyword && keyword.length > 10) {
            return createResponse(400, '关键词长度不能超过10个字符');
        }
        if (market && market.length > 6) {
            return createResponse(400, 'market 长度不能超过6个字符');
        }

        try {
            // 创建 D1 Session 以使用读复制
            // 从请求头获取上一次的 bookmark，如果没有则使用 "first-unconstrained"
            const bookmark = request.headers.get('x-d1-bookmark') ?? 'first-unconstrained';
            const session = env.DB.withSession(bookmark);

            // 计算偏移量
            const offset = (page - 1) * pageSize;

            // 构建 SQL 查询（不返回 pinyin 字段）
            let countQuery = 'SELECT COUNT(*) as total FROM stocks';
            let dataQuery = 'SELECT symbol, name, market FROM stocks';
            const whereConditions: string[] = [];
            const countParams: any[] = [];
            const dataParams: any[] = [];

            // 精确查询股票代码（使用主键索引，性能最优）
            if (symbol) {
                whereConditions.push('symbol = ?');
                countParams.push(symbol);
                dataParams.push(symbol);
            } 
            // 关键词搜索（支持代码、名称、拼音首字母）
            else if (keyword) {
                // 注意：LIKE '%keyword%' 无法使用索引，会全表扫描
                // 对于大表，建议限制搜索结果或考虑使用专门的搜索引擎
                whereConditions.push('(symbol LIKE ? OR name LIKE ? OR pinyin LIKE ?)');
                const keywordPattern = `%${keyword}%`;
                countParams.push(keywordPattern, keywordPattern, keywordPattern);
                dataParams.push(keywordPattern, keywordPattern, keywordPattern);
            }

            // 市场筛选（需要在 market 列上创建索引以提升性能）
            if (market) {
                whereConditions.push('market = ?');
                countParams.push(market);
                dataParams.push(market);
            }

            // 拼接 WHERE 子句
            if (whereConditions.length > 0) {
                const whereClause = ' WHERE ' + whereConditions.join(' AND ');
                countQuery += whereClause;
                dataQuery += whereClause;
            }

            // 添加排序和分页（symbol 已有主键索引，ORDER BY 性能较好）
            dataQuery += ' ORDER BY symbol LIMIT ? OFFSET ?';

            // 使用 session 查询总数
            const countResult = await session.prepare(countQuery)
                .bind(...countParams)
                .first<{ total: number }>();

            const total = countResult?.total || 0;
            const totalPages = Math.ceil(total / pageSize);

            // 使用 session 查询当前页数据
            const result = await session.prepare(dataQuery)
                .bind(...dataParams, pageSize, offset)
                .all<{ symbol: string; name: string; market: string }>();

            // 将字段名转换为中文
            const stockList = (result.results || []).map(stock => ({
                '股票代码': stock.symbol,
                '股票简称': stock.name,
                '市场代码': stock.market,
            }));

            const responseData: any = {
                '数据源': 'D1数据库',
                '当前页': page,
                '每页数量': pageSize,
                '总数量': total,
                '总页数': totalPages,
                '股票列表': stockList,
            };

            // 添加 D1 元数据（用于调试和监控）
            if (result.meta) {
                responseData['_meta'] = {
                    'served_by_region': result.meta.served_by_region,
                    'served_by_primary': result.meta.served_by_primary,
                };
            }

            // 创建响应
            const response = createResponse(200, 'success', responseData);

            // 将 session bookmark 添加到响应头，以便后续请求继续使用
            const newBookmark = session.getBookmark();
            if (newBookmark) {
                response.headers.set('x-d1-bookmark', newBookmark);
            }

            return response;
        } catch (err: any) {
            console.error('Error fetching stock list:', err);
            return createResponse(500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }
}
