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
     * 从完整页面 HTML 中截取指定 id 的 div 区域
     */
    private static extractSection(html: string, id: string): string {
        const startMarker = `id="${id}"`;
        const startIdx = html.indexOf(startMarker);
        if (startIdx === -1) return '';

        const divStart = html.lastIndexOf('<div', startIdx);
        if (divStart === -1) return '';

        let depth = 0;
        let i = divStart;
        while (i < html.length) {
            if (html[i] === '<') {
                if (html.substring(i, i + 4) === '<div') {
                    depth++;
                } else if (html.substring(i, i + 6) === '</div>') {
                    depth--;
                    if (depth === 0) {
                        return html.substring(divStart, i + 6);
                    }
                }
            }
            i++;
        }

        return html.substring(divStart, Math.min(divStart + 50000, html.length));
    }

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

        const hasNoPrediction = html.includes('本年度暂无机构做出业绩预测');

        const result: Record<string, any> = {
            '摘要': '',
            '预测年报每股收益': [],
            '预测年报净利润': [],
            '业绩预测详表_机构': [],
            '业绩预测详表_详细指标预测': [],
        };

        // #forecast 区域：摘要 + 预测年报每股收益 + 预测年报净利润
        const forecastHtml = this.extractSection(html, 'forecast');
        if (forecastHtml) {
            const $f = cheerio.load(forecastHtml, { scriptingEnabled: false });
            result['摘要'] = $f('p.tip.clearfix').text().trim().replace(/\s+/g, ' ');

            if (!hasNoPrediction) {
                const fTables = $f('table');
                if (fTables.length > 0) result['预测年报每股收益'] = parseTable($f, fTables[0], '预测年报每股收益');
                if (fTables.length > 1) result['预测年报净利润'] = parseTable($f, fTables[1], '预测年报净利润');
            }
        }

        // #forecastdetail 区域：业绩预测详表_机构 + 业绩预测详表_详细指标预测
        const detailHtml = this.extractSection(html, 'forecastdetail');
        if (detailHtml) {
            const $d = cheerio.load(detailHtml, { scriptingEnabled: false });
            const dTables = $d('table');

            if (hasNoPrediction) {
                if (dTables.length > 0) result['业绩预测详表_机构'] = parseTable($d, dTables[0], '业绩预测详表-机构');
                if (dTables.length > 1) result['业绩预测详表_详细指标预测'] = parseTable($d, dTables[1], '业绩预测详表-详细指标预测');
            } else {
                if (dTables.length > 0) result['业绩预测详表_机构'] = parseTable($d, dTables[0], '业绩预测详表-机构');
                if (dTables.length > 1) result['业绩预测详表_详细指标预测'] = parseTable($d, dTables[1], '业绩预测详表-详细指标预测');
            }
        }

        return result;
    }
}
