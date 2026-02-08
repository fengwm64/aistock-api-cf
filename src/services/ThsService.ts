import * as cheerio from 'cheerio';
import { parseTable } from '../utils/parser';

/**
 * 同花顺数据服务
 * 提供股票盈利预测数据查询
 */
export class ThsService {
    /** 同花顺股票价值分析页面 URL */
    private static readonly BASE_URL = 'https://basic.10jqka.com.cn/new';

    private static readonly HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    };

    /**
     * 获取股票盈利预测数据
     * @param symbol 6位股票代码
     */
    static async getProfitForecast(symbol: string): Promise<Record<string, any>> {
        const url = `${this.BASE_URL}/${symbol}/worth.html`;

        const response = await fetch(url, { headers: this.HEADERS });
        if (!response.ok) {
            throw new Error(`同花顺接口请求失败: ${response.status}`);
        }

        // GBK 解码
        const arrayBuffer = await response.arrayBuffer();
        const html = new TextDecoder('gbk').decode(arrayBuffer);

        const $ = cheerio.load(html);
        const tables = $('table');
        const hasNoPrediction = html.includes('本年度暂无机构做出业绩预测');

        const result: Record<string, any[]> = {
            '预测年报每股收益': [],
            '预测年报净利润': [],
            '业绩预测详表_机构': [],
        };

        if (hasNoPrediction) {
            if (tables.length > 0) {
                result['业绩预测详表_机构'] = parseTable($, tables[0], '业绩预测详表-机构');
            }
        } else {
            if (tables.length > 0) result['预测年报每股收益'] = parseTable($, tables[0], '预测年报每股收益');
            if (tables.length > 1) result['预测年报净利润'] = parseTable($, tables[1], '预测年报净利润');
            if (tables.length > 2) result['业绩预测详表_机构'] = parseTable($, tables[2], '业绩预测详表-机构');
        }

        return result;
    }
}
