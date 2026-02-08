import { getStockIdentity } from '../utils/stock';

/**
 * 东方财富实时行情服务
 * 提供股票最新价、涨跌额、涨跌幅查询
 */
export class EmQuoteService {
    /** 行情接口 */
    private static readonly BASE_URL = 'https://push2.eastmoney.com/api/qt/stock/get';

    /** 请求字段: f43=最新价, f169=涨跌额(显示用, 已除权), f170=涨跌幅 */
    private static readonly FIELDS = 'f57,f58,f43,f169,f170';

    /** 字段编号 -> 中文名称映射 */
    private static readonly CODE_NAME_MAP: Record<string, string> = {
        'f57': '股票代码',
        'f58': '股票简称',
        'f43': '最新价',
        'f169': '涨跌额',
        'f170': '涨跌幅',
    };

    /**
     * 获取单只股票实时行情
     * @param symbol 6位股票代码
     */
    static async getQuote(symbol: string): Promise<Record<string, any>> {
        const identity = getStockIdentity(symbol);
        const { eastmoneyId } = identity;

        const url = `${this.BASE_URL}?invt=2&fltt=2&fields=${this.FIELDS}&secid=${eastmoneyId}.${symbol}`;

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'zh-CN,zh;q=0.9',
                'Referer': 'https://quote.eastmoney.com/',
            },
        });

        if (!response.ok) {
            throw new Error(`东方财富行情接口请求失败: ${response.status}`);
        }

        const json: any = await response.json();
        const innerData = json.data;

        if (!innerData) {
            throw new Error('东方财富行情接口返回数据格式异常');
        }

        const result: Record<string, any> = {};

        for (const [key, name] of Object.entries(this.CODE_NAME_MAP)) {
            if (key in innerData) {
                result[name] = innerData[key];
            }
        }

        return result;
    }
}
