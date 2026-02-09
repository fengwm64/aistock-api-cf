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

        const hasNoPrediction = html.includes('本年度暂无机构做出业绩预测');

        // 剥离 script / style / HTML 注释，大幅缩减 cheerio 需要解析的 DOM 树
        const cleanHtml = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '');

        const $ = cheerio.load(cleanHtml, { scriptingEnabled: false });

        const result: Record<string, any> = {
            '摘要': '',
            '预测年报每股收益': [],
            '预测年报净利润': [],
            '业绩预测详表_机构': [],
            '业绩预测详表_详细指标预测': [],
        };

        // 摘要
        result['摘要'] = $('#forecast > div.bd > p.tip.clearfix').text().trim().replace(/\s+/g, ' ');

        // 预测年报每股收益 + 预测年报净利润
        if (!hasNoPrediction) {
            const epsTable = $('#forecast > div.bd > div.clearfix > div.fl.yjyc > table');
            if (epsTable.length > 0) result['预测年报每股收益'] = parseTable($, epsTable[0], '预测年报每股收益');

            const profitTable = $('#forecast > div.bd > div.clearfix > div.fr.yjyc > table');
            if (profitTable.length > 0) result['预测年报净利润'] = parseTable($, profitTable[0], '预测年报净利润');
        }

        // 业绩预测详表_机构
        const instTable = $('#forecastdetail > div.bd > table.m_table.m_hl.posi_table');
        if (instTable.length > 0) result['业绩预测详表_机构'] = parseTable($, instTable[0], '业绩预测详表-机构');

        // 业绩预测详表_详细指标预测
        const detailTable = $('#forecastdetail > div.bd > table.m_table.m_hl.ggintro.ggintro_1.organData');
        if (detailTable.length > 0) result['业绩预测详表_详细指标预测'] = parseTable($, detailTable[0], '业绩预测详表-详细指标预测');

        return result;
    }
}
