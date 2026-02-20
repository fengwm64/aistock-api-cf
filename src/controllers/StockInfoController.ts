import { EmService } from '../services/EmInfoService';
import { CacheService } from '../services/CacheService';
import {
    STOCK_INFO_CACHE_TTL_SECONDS,
    buildStockInfoCacheKey,
    buildTimestampedCachePayload,
    isValidStockInfoCachePayload,
    type StockInfoCachePayload,
} from '../constants/cache';
import { createResponse } from '../utils/response';
import { formatToChinaTime } from '../utils/datetime';
import { Env } from '../index';
import { isValidAShareSymbol } from '../utils/validator';
import { getStockIdentity } from '../utils/stock';

/** 单次最多查询股票数量 */
const MAX_SYMBOLS = 20;
const INDUSTRY_TAG_TYPE = '行业板块' as const;
const REGION_TAG_TYPE = '地域板块' as const;

interface BatchStockInfoResult {
    data: Record<string, any>;
    fromCache: boolean;
}

interface TagByNameRow {
    tag_name: string;
    tag_code: string;
}

/**
 * 股票基本信息控制器
 */
export class StockInfoController {
    private static normalizeText(value: unknown): string | null {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }

    private static getSymbol(data: Record<string, any>): string | null {
        return this.normalizeText(data['股票代码']);
    }

    private static getIndustryBoardName(data: Record<string, any>): string | null {
        return this.normalizeText(data['行业板块'] ?? data['所属行业']);
    }

    private static getRegionBoardName(data: Record<string, any>): string | null {
        return this.normalizeText(data['地域板块']);
    }

    private static async queryTagCodesByNames(
        env: Env,
        tagType: typeof INDUSTRY_TAG_TYPE | typeof REGION_TAG_TYPE,
        names: string[],
    ): Promise<Map<string, string>> {
        if (names.length === 0) return new Map();

        const placeholders = names.map((_, index) => `?${index + 2}`).join(', ');
        const sql = `
            SELECT tag_name, tag_code
            FROM tags
            WHERE tag_type = ?1
              AND tag_name IN (${placeholders})
        `;

        const result = await env.DB.prepare(sql).bind(tagType, ...names).all<TagByNameRow>();
        const mapping = new Map<string, string>();
        for (const row of result.results || []) {
            const tagName = this.normalizeText(row.tag_name);
            const tagCode = this.normalizeText(row.tag_code);
            if (!tagName || !tagCode) continue;
            mapping.set(tagName, tagCode);
        }
        return mapping;
    }

    private static async enrichBoardIds(
        items: Record<string, any>[],
        env: Env,
    ): Promise<Record<string, any>[]> {
        const enriched = items.map(item => ({ ...item }));
        if (enriched.length === 0) return enriched;

        const validItems = enriched.filter(item => !('错误' in item));

        const industryNames = Array.from(
            new Set(
                validItems
                    .map(item => this.getIndustryBoardName(item))
                    .filter((name): name is string => name !== null),
            ),
        );
        const regionNames = Array.from(
            new Set(
                validItems
                    .map(item => this.getRegionBoardName(item))
                    .filter((name): name is string => name !== null),
            ),
        );

        const [industryCodeByName, regionCodeByName] = await Promise.all([
            this.queryTagCodesByNames(env, INDUSTRY_TAG_TYPE, industryNames),
            this.queryTagCodesByNames(env, REGION_TAG_TYPE, regionNames),
        ]);

        const missingTagMessages: string[] = [];
        for (const item of validItems) {
            const symbol = this.getSymbol(item);
            const industryName = this.getIndustryBoardName(item);
            const regionName = this.getRegionBoardName(item);
            if (!symbol) continue;

            if (industryName && !industryCodeByName.get(industryName)) {
                missingTagMessages.push(`${symbol}(行业板块=${industryName})`);
            }
            if (regionName && !regionCodeByName.get(regionName)) {
                missingTagMessages.push(`${symbol}(地域板块=${regionName})`);
            }
        }
        if (missingTagMessages.length > 0) {
            throw new Error(`tags表未找到板块ID: ${missingTagMessages.join('; ')}`);
        }

        for (const item of enriched) {
            if ('错误' in item) {
                item['行业板块ID'] = null;
                item['地域板块ID'] = null;
                continue;
            }

            const industryName = this.getIndustryBoardName(item);
            const regionName = this.getRegionBoardName(item);
            item['行业板块ID'] = industryName ? (industryCodeByName.get(industryName) ?? null) : null;
            item['地域板块ID'] = regionName ? (regionCodeByName.get(regionName) ?? null) : null;
        }

        return enriched;
    }

    private static getSourceBySymbol(symbol: string): string {
        const { eastmoneyId } = getStockIdentity(symbol);
        const prefix = eastmoneyId === 1 ? 'sh' : 'sz';
        return `东方财富 http://quote.eastmoney.com/concept/${prefix}${symbol}.html?from=classic`;
    }

    private static async fetchAndMaybeCache(
        symbol: string,
        cacheService: CacheService | null,
    ): Promise<Record<string, any>> {
        const data = await EmService.getStockInfo(symbol);

        if (cacheService && Object.keys(data).length > 0) {
            const now = Date.now();
            try {
                cacheService.set(
                    buildStockInfoCacheKey(symbol),
                    buildTimestampedCachePayload(data, now),
                    STOCK_INFO_CACHE_TTL_SECONDS,
                );
            } catch (err) {
                console.error(`Error writing stock info cache for ${symbol}:`, err);
            }
        }

        return data;
    }

    static async getStockInfo(symbol: string, env: Env, ctx: ExecutionContext) {
        if (!symbol) {
            return createResponse(400, '缺少 symbol 参数');
        }
        if (!isValidAShareSymbol(symbol)) {
            return createResponse(400, 'Invalid symbol - A股代码必须是6位数字');
        }

        const cacheKey = buildStockInfoCacheKey(symbol);
        const source = this.getSourceBySymbol(symbol);

        try {
            let cachedWrapper: unknown = null;
            const cacheService = env.KV ? new CacheService(env.KV, ctx) : null;

            if (cacheService) {
                try {
                    cachedWrapper = await cacheService.get<StockInfoCachePayload>(cacheKey);
                } catch (err) {
                    console.error(`Error reading stock info cache for ${symbol}:`, err);
                }
            }

            // 命中缓存：不刷新 TTL（硬过期）
            if (isValidStockInfoCachePayload(cachedWrapper)) {
                const [enrichedData] = await this.enrichBoardIds([cachedWrapper.data], env);
                return createResponse(200, 'success (cached)', {
                    '来源': source,
                    '更新时间': formatToChinaTime(cachedWrapper.timestamp),
                    ...enrichedData,
                });
            }

            // 未命中缓存：请求源数据
            const data = await this.fetchAndMaybeCache(symbol, cacheService);
            const [enrichedData] = await this.enrichBoardIds([data], env);
            const now = Date.now();

            return createResponse(200, 'success', {
                '来源': source,
                '更新时间': formatToChinaTime(now),
                ...enrichedData,
            });
        } catch (err: any) {
            console.error(`Error fetching stock info for ${symbol}:`, err);
            return createResponse(500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }

    private static async getStockInfoForBatch(
        symbol: string,
        cacheService: CacheService | null,
    ): Promise<BatchStockInfoResult> {
        const cacheKey = buildStockInfoCacheKey(symbol);

        if (cacheService) {
            try {
                const cachedWrapper = await cacheService.get<StockInfoCachePayload>(cacheKey);
                if (isValidStockInfoCachePayload(cachedWrapper)) {
                    return {
                        data: cachedWrapper.data,
                        fromCache: true,
                    };
                }
            } catch (err) {
                console.error(`Error reading stock info cache for ${symbol}:`, err);
            }
        }

        try {
            const data = await this.fetchAndMaybeCache(symbol, cacheService);
            return {
                data,
                fromCache: false,
            };
        } catch (err) {
            console.error(`Error fetching info for ${symbol}:`, err);
            return {
                data: {
                    '市场代码': '-',
                    '股票代码': symbol,
                    '股票简称': '-',
                    '错误': err instanceof Error ? err.message : '查询失败',
                },
                fromCache: false,
            };
        }
    }

    /**
     * 批量获取股票基本信息
     */
    static async getBatchStockInfo(request: Request, env: Env, ctx: ExecutionContext) {
        const url = new URL(request.url);
        const symbolsParam = url.searchParams.get('symbols');

        if (!symbolsParam) {
            return createResponse(400, '缺少 symbols 参数，示例: ?symbols=000001,600519');
        }

        const symbols = [...new Set(symbolsParam.split(',').map(s => s.trim()).filter(Boolean))];

        if (symbols.length === 0) {
            return createResponse(400, '缺少 symbols 参数，示例: ?symbols=000001,600519');
        }

        if (symbols.length > MAX_SYMBOLS) {
            return createResponse(400, `单次最多查询 ${MAX_SYMBOLS} 只股票`);
        }

        const invalidSymbols = symbols.filter(s => !isValidAShareSymbol(s));
        if (invalidSymbols.length > 0) {
            return createResponse(400, `Invalid symbol(s) - A股代码必须是6位数字: ${invalidSymbols.join(', ')}`);
        }

        try {
            const cacheService = env.KV ? new CacheService(env.KV, ctx) : null;
            const batchResults = await Promise.all(symbols.map(symbol => this.getStockInfoForBatch(symbol, cacheService)));
            const allFromCache = batchResults.every(item => item.fromCache);
            const rawResults = batchResults.map(item => item.data);
            const results = await this.enrichBoardIds(rawResults, env);
            const now = Date.now();

            return createResponse(200, allFromCache ? 'success (cached)' : 'success', {
                '来源': '东方财富',
                '更新时间': formatToChinaTime(now),
                '股票数量': results.length,
                '股票信息': results,
            });
        } catch (err: any) {
            console.error('Error fetching batch stock info:', err);
            return createResponse(500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }
}
