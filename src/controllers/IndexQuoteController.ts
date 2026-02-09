import { getStockIdentity } from '../utils/stock';
import { formatToChinaTime } from '../utils/datetime';
import { createResponse } from '../utils/response';
import { isValidAShareSymbol } from '../utils/validator';
import { Env } from '../index';

/** 单次最多查询数量 */
const MAX_SYMBOLS = 20;

/** 需要 /100 的价格类字段 */
const PRICE_DIV_FIELDS = new Set(['f43', 'f44', 'f45', 'f46', 'f60', 'f170', 'f169', 'f168']);

/** 请求字段 */
const INDEX_FIELDS = 'f57,f58,f43,f44,f45,f46,f47,f48,f60,f170,f169,f168,f296,f86';

/** 字段编号 -> 中文名称 */
const FIELD_NAME_MAP: Record<string, string> = {
    'f57': '指数代码',
    'f58': '指数简称',
    'f43': '最新价',
    'f44': '最高价',
    'f45': '最低价',
    'f46': '今开价',
    'f47': '成交量',
    'f48': '成交额',
    'f60': '昨收价',
    'f170': '涨跌幅',
    'f169': '涨跌额',
    'f168': '换手率',
    'f296': '成交笔数',
    'f86': '更新时间',
};

const BASE_URL = 'https://push2.eastmoney.com/api/qt/stock/get';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Referer': 'https://quote.eastmoney.com/',
};

/**
 * 获取单只指数行情
 */
async function getIndexQuote(symbol: string): Promise<Record<string, any>> {
    // 通过股票代码得到 eastmoneyId，然后取反得到指数的 eastmoneyId
    const { eastmoneyId } = getStockIdentity(symbol);
    const indexId = eastmoneyId === 1 ? 0 : 1;

    const url = `${BASE_URL}?invt=2&fltt=1&fields=${INDEX_FIELDS}&secid=${indexId}.${symbol}`;
    const response = await fetch(url, { headers: HEADERS });

    if (!response.ok) {
        throw new Error(`东方财富指数接口请求失败: ${response.status}`);
    }

    const json: any = await response.json();
    const innerData = json.data;

    if (!innerData) {
        throw new Error(`指数 ${symbol} 数据不存在`);
    }

    const result: Record<string, any> = {};

    for (const [key, name] of Object.entries(FIELD_NAME_MAP)) {
        if (!(key in innerData)) continue;
        let value = innerData[key];

        if (PRICE_DIV_FIELDS.has(key) && typeof value === 'number') {
            value = value / 100;
        } else if (key === 'f47' && typeof value === 'number') {
            value = value * 100; // 手 -> 股
        } else if (key === 'f86' && typeof value === 'number') {
            value = formatToChinaTime(value * 1000);
        }

        result[name] = value;
    }

    return result;
}

/**
 * 指数实时行情控制器
 */
export class IndexQuoteController {
    static async getIndexQuotes(request: Request, env: Env, ctx: ExecutionContext) {
        const url = new URL(request.url);
        const symbolsParam = url.searchParams.get('symbols');

        if (!symbolsParam) {
            return createResponse(400, '缺少 symbols 参数，示例: ?symbols=000001,399006');
        }

        const symbols = [...new Set(symbolsParam.split(',').map(s => s.trim()).filter(Boolean))];

        if (symbols.length === 0) {
            return createResponse(400, '缺少 symbols 参数，示例: ?symbols=000001,399006');
        }

        if (symbols.length > MAX_SYMBOLS) {
            return createResponse(400, `单次最多查询 ${MAX_SYMBOLS} 只指数`);
        }

        const invalidSymbols = symbols.filter(s => !isValidAShareSymbol(s));
        if (invalidSymbols.length > 0) {
            return createResponse(400, `Invalid symbol(s) - 指数代码必须是6位数字: ${invalidSymbols.join(', ')}`);
        }

        try {
            const results = await Promise.allSettled(symbols.map(s => getIndexQuote(s)));

            const quotes = results.map((r, i) =>
                r.status === 'fulfilled'
                    ? r.value
                    : { '指数代码': symbols[i], '错误': r.reason?.message || '查询失败' }
            );

            return createResponse(200, 'success', {
                '来源': '东方财富',
                '指数数量': quotes.length,
                '行情': quotes,
            });
        } catch (err: any) {
            return createResponse(500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }
}
