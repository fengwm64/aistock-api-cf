import { getStockIdentity } from '../utils/stock';
import { eastmoneyThrottler } from '../utils/throttlers';

/**
 * 东方财富数据服务
 * 提供股票基本信息查询
 */
export class EmService {
    /** 请求字段列表 */
    private static readonly FIELDS = 'f57,f58,f127,f116,f117,f189,f84,f85,f128';

    /** 字段编号 -> 中文名称映射 */
    private static readonly CODE_NAME_MAP: Record<string, string> = {
        'f57': '股票代码',
        'f58': '股票简称',
        'f84': '总股本',
        'f85': '流通股',
        'f127': '所属行业',
        'f116': '总市值',
        'f117': '流通市值',
        'f189': '上市时间',
        "f128": "所属板块",
    };

    /** API 基础 URL */
    private static readonly BASE_URL = 'https://push2.eastmoney.com/api/qt/stock/get';

    /**
     * 获取股票基本信息
     * @param symbol 6位股票代码
     */
    static async getStockInfo(symbol: string): Promise<Record<string, any>> {
        const identity = getStockIdentity(symbol);
        const { eastmoneyId } = identity;

        const url = `${this.BASE_URL}?invt=2&fltt=2&fields=${this.FIELDS}&secid=${eastmoneyId}.${symbol}`;

        // 限流 (东方财富)
        await eastmoneyThrottler.throttle();

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
            throw new Error(`东方财富接口请求失败: ${response.status}`);
        }

        const json: any = await response.json();
        const innerData = json.data;

        if (!innerData) {
            throw new Error('东方财富接口返回数据格式异常');
        }

        const result: Record<string, any> = {
            '市场': identity.market,
            '板块': identity.board,
        };

        for (const [key, name] of Object.entries(this.CODE_NAME_MAP)) {
            if (key in innerData) {
                result[name] = innerData[key];
            }
        }

        return result;
    }
}
