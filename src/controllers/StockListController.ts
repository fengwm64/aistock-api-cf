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

        try {
            // 创建 D1 Session 以使用读复制
            // 从请求头获取上一次的 bookmark，如果没有则使用 "first-unconstrained"
            const bookmark = request.headers.get('x-d1-bookmark') ?? 'first-unconstrained';
            const session = env.DB.withSession(bookmark);

            // 计算偏移量
            const offset = (page - 1) * pageSize;

            // 构建 SQL 查询
            let countQuery = 'SELECT COUNT(*) as total FROM stocks';
            let dataQuery = 'SELECT symbol, name FROM stocks';
            const params: any[] = [];

            // 精确查询优先级最高
            if (symbol) {
                if (symbol.length > 20) {
                    return createResponse(400, 'symbol 长度不能超过20个字符');
                }
                countQuery += ' WHERE symbol = ?';
                dataQuery += ' WHERE symbol = ?';
                params.push(symbol);
            } 
            // 关键词搜索
            else if (keyword) {
                if (keyword.length > 20) {
                    return createResponse(400, '关键词长度不能超过20个字符');
                }
                countQuery += ' WHERE symbol LIKE ? OR name LIKE ?';
                dataQuery += ' WHERE symbol LIKE ? OR name LIKE ?';
                params.push(`%${keyword}%`, `%${keyword}%`);
            }

            // 添加排序和分页
            dataQuery += ' ORDER BY symbol LIMIT ? OFFSET ?';

            // 使用 session 查询总数
            const countResult = await session.prepare(countQuery)
                .bind(...params)
                .first<{ total: number }>();

            const total = countResult?.total || 0;
            const totalPages = Math.ceil(total / pageSize);

            // 使用 session 查询当前页数据
            const result = await session.prepare(dataQuery)
                .bind(...params, pageSize, offset)
                .all<{ symbol: string; name: string }>();

            const responseData: any = {
                '数据源': 'D1数据库',
                '当前页': page,
                '每页数量': pageSize,
                '总数量': total,
                '总页数': totalPages,
                '股票列表': result.results || [],
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
