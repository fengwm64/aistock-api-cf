import { ThsService } from '../services/ThsService';
import { createResponse } from '../utils/response';
import { getBooleanQueryParam } from '../utils/query';
import { Env } from '../index';

interface EarningsForecastRow {
    update_time: string;
    summary: string | null;
    forecast_detail: unknown;
    forecast_netprofit_yoy: unknown;
}

interface ForecastListRow {
    symbol: string;
    stock_name: string | null;
    update_time: string;
    summary: string | null;
    forecast_netprofit_yoy: unknown;
}

type ForecastSortBy = 'symbol' | 'forecast_netprofit_yoy';
type ForecastSortOrder = 'asc' | 'desc';

interface CommonListParams {
    page: number;
    pageSize: number;
    sortBy: ForecastSortBy;
    sortOrder: ForecastSortOrder;
}

/**
 * 盈利预测控制器
 */
export class ProfitForecastController {
    private static readonly DEFAULT_PAGE_SIZE = 50;
    private static readonly MAX_PAGE_SIZE = 500;
    private static readonly DEFAULT_SORT_BY: ForecastSortBy = 'forecast_netprofit_yoy';
    private static readonly ALLOWED_SORT_BY = new Set<ForecastSortBy>(['symbol', 'forecast_netprofit_yoy']);
    private static readonly ALLOWED_SORT_ORDER = new Set<ForecastSortOrder>(['asc', 'desc']);
    private static readonly LATEST_FORECAST_CTE = `
        WITH latest AS (
            SELECT e.symbol, e.update_time, e.summary, e.forecast_detail, e.forecast_netprofit_yoy
            FROM earnings_forecast e
            INNER JOIN (
                SELECT symbol, MAX(update_time) AS latest_update_time
                FROM earnings_forecast
                GROUP BY symbol
            ) m
                ON e.symbol = m.symbol
               AND e.update_time = m.latest_update_time
        )
    `;

    /**
     * 生成中国时区时间（带毫秒），避免同一秒重复写入触发复合主键冲突
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

    private static parseForecastDetail(raw: unknown): any[] {
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string') {
            try {
                const parsed = JSON.parse(raw);
                return Array.isArray(parsed) ? parsed : [];
            } catch {
                return [];
            }
        }
        return [];
    }

    private static parseForecastNetProfitYoy(raw: unknown): number | null {
        if (raw === null || raw === undefined || raw === '') return null;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : null;
    }

    private static extractForecastNetProfitYoy(summary: string): number | null {
        if (!summary) return null;
        const normalized = summary.replace(/[−－]/g, '-').replace(/\s+/g, '');
        const patterns = [
            /预测\d{4}年净利润[^，,。；;]*(?:，|,)较去年同比(增长|下降)(-?\d+(?:\.\d+)?)%/,
            /净利润[^，,。；;]*(?:，|,)较去年同比(增长|下降)(-?\d+(?:\.\d+)?)%/,
        ];

        for (const pattern of patterns) {
            const match = normalized.match(pattern);
            if (!match) continue;
            const direction = match[1];
            const value = Number(match[2]);
            if (!Number.isFinite(value)) return null;
            return direction === '下降' ? -Math.abs(value) : Math.abs(value);
        }

        return null;
    }

    private static parseCommonListParams(url: URL): CommonListParams | { error: string } {
        const pageParam = url.searchParams.get('page');
        const pageSizeParam = url.searchParams.get('pageSize');
        const sortByRaw = (url.searchParams.get('sortBy') || url.searchParams.get('sort') || this.DEFAULT_SORT_BY).trim();
        const sortOrderRaw = (url.searchParams.get('sortOrder') || url.searchParams.get('order') || '').trim().toLowerCase();

        let page = 1;
        if (pageParam) {
            const parsed = Number(pageParam);
            if (!Number.isInteger(parsed) || parsed < 1) {
                return { error: 'Invalid page - page 必须是大于0的整数' };
            }
            page = parsed;
        }

        let pageSize = this.DEFAULT_PAGE_SIZE;
        if (pageSizeParam) {
            const parsed = Number(pageSizeParam);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > this.MAX_PAGE_SIZE) {
                return { error: `Invalid pageSize - pageSize 必须是 1-${this.MAX_PAGE_SIZE} 的整数` };
            }
            pageSize = parsed;
        }

        if (!this.ALLOWED_SORT_BY.has(sortByRaw as ForecastSortBy)) {
            return { error: 'Invalid sortBy - 仅支持 symbol 或 forecast_netprofit_yoy' };
        }
        const sortBy = sortByRaw as ForecastSortBy;

        const defaultOrder: ForecastSortOrder = sortBy === 'symbol' ? 'asc' : 'desc';
        const finalSortOrder = (sortOrderRaw || defaultOrder) as ForecastSortOrder;
        if (!this.ALLOWED_SORT_ORDER.has(finalSortOrder)) {
            return { error: 'Invalid sortOrder - 仅支持 asc 或 desc' };
        }

        return {
            page,
            pageSize,
            sortBy,
            sortOrder: finalSortOrder,
        };
    }

    private static buildOrderBy(sortBy: ForecastSortBy, sortOrder: ForecastSortOrder): string {
        const order = sortOrder.toUpperCase();
        if (sortBy === 'symbol') {
            return `l.symbol ${order}`;
        }
        return `l.forecast_netprofit_yoy IS NULL ASC, l.forecast_netprofit_yoy ${order}, l.symbol ASC`;
    }

    private static mapForecastRow(row: ForecastListRow) {
        return {
            '股票代码': row.symbol,
            '股票简称': row.stock_name || '',
            '更新时间': row.update_time,
            '净利润同比(%)': this.parseForecastNetProfitYoy(row.forecast_netprofit_yoy),
            '摘要': row.summary || '',
        };
    }

    static async getThsForecast(symbol: string, request: Request, env: Env, ctx: ExecutionContext) {
        if (!symbol) {
            return createResponse(400, '缺少 symbol 参数');
        }

        const forceRefresh = getBooleanQueryParam(request, ['forceRefresh', 'force_refresh', 'refresh']);
        const source = `同花顺 https://basic.10jqka.com.cn/new/${symbol}/worth.html`;

        try {
            if (!forceRefresh) {
                // 先查 D1：命中则直接返回
                const latest = await env.DB
                    .prepare(
                        `SELECT update_time, summary, forecast_detail, forecast_netprofit_yoy
                         FROM earnings_forecast
                         WHERE symbol = ?1
                         ORDER BY update_time DESC
                         LIMIT 1`
                    )
                    .bind(symbol)
                    .first<EarningsForecastRow>();

                if (latest) {
                    return createResponse(200, 'success (d1)', {
                        '股票代码': symbol,
                        '来源': source,
                        '更新时间': latest.update_time,
                        '摘要': latest.summary || '',
                        '净利润同比(%)': this.parseForecastNetProfitYoy(latest.forecast_netprofit_yoy),
                        '业绩预测详表_详细指标预测': this.parseForecastDetail(latest.forecast_detail),
                    });
                }
            }

            // D1 未命中：爬取并写入 D1
            const data = await ThsService.getProfitForecast(symbol);
            const now = Date.now();
            const updateTime = this.formatToChinaTimeWithMs(now);
            const summary = typeof data['摘要'] === 'string' ? data['摘要'] : '';
            const forecastNetProfitYoy = this.extractForecastNetProfitYoy(summary);

            // 写入 D1（仅保留摘要 + 详细指标预测）
            await env.DB
                .prepare(
                    `INSERT INTO earnings_forecast
                        (symbol, update_time, summary, forecast_detail, forecast_netprofit_yoy)
                     VALUES
                        (?1, ?2, ?3, ?4, ?5)`
                )
                .bind(
                    symbol,
                    updateTime,
                    summary,
                    JSON.stringify(data['业绩预测详表_详细指标预测'] ?? []),
                    forecastNetProfitYoy,
                )
                .run();

            return createResponse(200, forceRefresh ? 'success (refresh)' : 'success', {
                '股票代码': symbol,
                '来源': source,
                '更新时间': updateTime,
                '净利润同比(%)': forecastNetProfitYoy,
                ...data,
            });
        } catch (error: any) {
            return createResponse(500, error.message);
        }
    }

    static async getForecastList(request: Request, env: Env, ctx: ExecutionContext) {
        const url = new URL(request.url);
        const parsed = this.parseCommonListParams(url);
        if ('error' in parsed) {
            return createResponse(400, parsed.error);
        }

        const { page, pageSize, sortBy, sortOrder } = parsed;
        const offset = (page - 1) * pageSize;
        const orderBy = this.buildOrderBy(sortBy, sortOrder);

        const bookmark = request.headers.get('x-d1-bookmark') ?? 'first-unconstrained';
        const session = env.DB.withSession(bookmark);

        try {
            const countQuery = `${this.LATEST_FORECAST_CTE}
                SELECT COUNT(*) AS total
                FROM latest l
                WHERE l.forecast_netprofit_yoy IS NOT NULL`;
            const countResult = await session.prepare(countQuery).first<{ total: number }>();
            const total = countResult?.total || 0;
            const totalPages = Math.ceil(total / pageSize);

            const dataQuery = `${this.LATEST_FORECAST_CTE}
                SELECT l.symbol, s.name AS stock_name, l.update_time, l.summary, l.forecast_netprofit_yoy
                FROM latest l
                LEFT JOIN stocks s ON s.symbol = l.symbol
                WHERE l.forecast_netprofit_yoy IS NOT NULL
                ORDER BY ${orderBy}
                LIMIT ?1 OFFSET ?2`;
            const result = await session.prepare(dataQuery)
                .bind(pageSize, offset)
                .all<ForecastListRow>();

            const list = (result.results || []).map(item => this.mapForecastRow(item));
            const response = createResponse(200, 'success', {
                '数据源': 'D1数据库',
                '排序字段': sortBy,
                '排序方向': sortOrder,
                '当前页': page,
                '每页数量': pageSize,
                '总数量': total,
                '总页数': totalPages,
                '盈利预测列表': list,
            });

            const newBookmark = session.getBookmark();
            if (newBookmark) response.headers.set('x-d1-bookmark', newBookmark);
            return response;
        } catch (error: any) {
            return createResponse(500, error instanceof Error ? error.message : 'Internal Server Error');
        }
    }

    static async searchForecastList(request: Request, env: Env, ctx: ExecutionContext) {
        const url = new URL(request.url);
        const keyword = (url.searchParams.get('keyword') || url.searchParams.get('q') || '').trim();
        if (!keyword) {
            return createResponse(400, '缺少 keyword 参数');
        }
        if (keyword.length > 30) {
            return createResponse(400, 'keyword 长度不能超过30个字符');
        }

        const parsed = this.parseCommonListParams(url);
        if ('error' in parsed) {
            return createResponse(400, parsed.error);
        }

        const { page, pageSize, sortBy, sortOrder } = parsed;
        const offset = (page - 1) * pageSize;
        const orderBy = this.buildOrderBy(sortBy, sortOrder);
        const keywordPattern = `%${keyword}%`;

        const bookmark = request.headers.get('x-d1-bookmark') ?? 'first-unconstrained';
        const session = env.DB.withSession(bookmark);

        try {
            const countQuery = `${this.LATEST_FORECAST_CTE}
                SELECT COUNT(*) AS total
                FROM latest l
                LEFT JOIN stocks s ON s.symbol = l.symbol
                WHERE l.forecast_netprofit_yoy IS NOT NULL
                  AND (
                       l.symbol LIKE ?1
                   OR COALESCE(s.name, '') LIKE ?1
                   OR COALESCE(s.pinyin, '') LIKE ?1
                  )`;
            const countResult = await session.prepare(countQuery).bind(keywordPattern).first<{ total: number }>();
            const total = countResult?.total || 0;
            const totalPages = Math.ceil(total / pageSize);

            const dataQuery = `${this.LATEST_FORECAST_CTE}
                SELECT l.symbol, s.name AS stock_name, l.update_time, l.summary, l.forecast_netprofit_yoy
                FROM latest l
                LEFT JOIN stocks s ON s.symbol = l.symbol
                WHERE l.forecast_netprofit_yoy IS NOT NULL
                  AND (
                       l.symbol LIKE ?1
                   OR COALESCE(s.name, '') LIKE ?1
                   OR COALESCE(s.pinyin, '') LIKE ?1
                  )
                ORDER BY ${orderBy}
                LIMIT ?2 OFFSET ?3`;
            const result = await session.prepare(dataQuery)
                .bind(keywordPattern, pageSize, offset)
                .all<ForecastListRow>();

            const list = (result.results || []).map(item => this.mapForecastRow(item));
            const response = createResponse(200, 'success', {
                '数据源': 'D1数据库',
                '关键词': keyword,
                '排序字段': sortBy,
                '排序方向': sortOrder,
                '当前页': page,
                '每页数量': pageSize,
                '总数量': total,
                '总页数': totalPages,
                '盈利预测列表': list,
            });

            const newBookmark = session.getBookmark();
            if (newBookmark) response.headers.set('x-d1-bookmark', newBookmark);
            return response;
        } catch (error: any) {
            return createResponse(500, error instanceof Error ? error.message : 'Internal Server Error');
        }
    }
}
