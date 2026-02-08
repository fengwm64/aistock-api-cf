// import { load } from 'cheerio';
import * as cheerio from 'cheerio';
const load = cheerio.load;

// import iconv from 'iconv-lite'; // Removed in favor of native TextDecoder
// import { Buffer } from 'node:buffer'; // Not needed for TextDecoder
import { parseTable } from '../utils/parser';

export class ThsService {
    static async getProfitForecast(symbol: string) {
        const targetUrl = `https://basic.10jqka.com.cn/new/${symbol}/worth.html`;
        
        const headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
        };


        const response = await fetch(targetUrl, { headers });
        if (!response.ok) {
            throw new Error(`Failed to fetch data: ${response.status}`);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        // Use native TextDecoder for GBK decoding (supported in Workers)
        const decoder = new TextDecoder('gbk');
        const decodedBody = decoder.decode(arrayBuffer);
        
        const $ = load(decodedBody);
        
        const hasNoPrediction = decodedBody.includes("本年度暂无机构做出业绩预测");
        
        const tables = $('table');
        const result: any = {
            "预测年报每股收益": [],
            "预测年报净利润": [],
            "业绩预测详表_机构": []
        };

        if (hasNoPrediction) {
            if (tables.length > 0) {
                result["业绩预测详表_机构"] = parseTable($, tables[0], "业绩预测详表-机构");
            }
        } else {
            if (tables.length > 0) result["预测年报每股收益"] = parseTable($, tables[0], "预测年报每股收益");
            if (tables.length > 1) result["预测年报净利润"] = parseTable($, tables[1], "预测年报净利润");
            if (tables.length > 2) result["业绩预测详表_机构"] = parseTable($, tables[2], "业绩预测详表-机构");
        }
        
        return result;
    }
}
