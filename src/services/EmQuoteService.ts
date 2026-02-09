import { getStockIdentity } from '../utils/stock';
import { formatToChinaTime } from '../utils/datetime';

/** 查询级别 */
export type QuoteLevel = 'core' | 'activity' | 'fundamental';

/** 需要从 手 转换为 股 的字段 */
const VOLUME_FIELDS = new Set(['f47', 'f49', 'f161']);

/**
 * 东方财富实时行情服务
 * 提供股票最新价、涨跌额、涨跌幅查询
 */
export class EmQuoteService {
    /** 行情接口 */
    private static readonly BASE_URL = 'https://push2.eastmoney.com/api/qt/stock/get';

    /* 
     * 一级请求字段（核心行情接口，适合高频请求，字段较少，保证快速响应）
     * f57: 股票代码
     * f58: 股票简称
     * f43: 最新价
     * f170: 涨跌幅
     * f86: 更新时间
    */
    private static readonly CORE_FIELDS = 'f57,f58,f43,f170,f86';

    /*
    * 二级请求字段：盘口/活跃度接口（中频）
    * f57: 股票代码
    * f58: 股票简称
    * f43: 最新价
    * f71: 均价
    * f170: 涨跌幅
    * f169: 涨跌额
    * f47: 成交量（手）→ 返回时转换为股
    * f48: 成交额（元）
    * f168: 换手率（%）
    * f50: 量比
    * f44: 最高价
    * f45: 最低价
    * f46: 今开价
    * f60: 昨收价
    * f51: 涨停价
    * f52: 跌停价
    * f49: 外盘（手）→ 返回时转换为股
    * f161: 内盘（手）→ 返回时转换为股
    * f86: 更新时间（Unix秒级时间戳，返回时已转换为可读格式）
    */
    private static readonly ACTIVITY_FIELDS = 'f57,f58,f43,f71,f170,f169,f47,f48,f168,f50,f44,f45,f46,f60,f51,f52,f49,f161,f86';

    /* 
     * 三级请求字段：估值/基本面接口
     * f57: 股票代码
     * f58: 股票简称
     * f55: 季度收益
     * f162: 动态市盈率
     * f92: 每股净资产
     * f167: 市净率
     * f183: 总营收
     * f184: 总营收-同比
     * f105: 净利润
     * f185: 净利润-同比
     * f186: 毛利率
     * f187: 净利率
     * f173: ROE
     * f188: 负债率
     * f84: 总股本
     * f85: 流通股
     * f116: 总市值
     * f117: 流通市值
     * f190: 每股未分配利润
     * f86: 更新时间
    */
    private static readonly FUNDAMENTAL_FIELDS = 'f57,f58,f55,f162,f92,f167,f183,f184,f105,f185,f186,f187,f173,f188,f84,f85,f116,f117,f190,f86';

    /** 级别 -> 请求字段 映射 */
    private static readonly LEVEL_FIELDS: Record<QuoteLevel, string> = {
        'core': EmQuoteService.CORE_FIELDS,
        'activity': EmQuoteService.ACTIVITY_FIELDS,
        'fundamental': EmQuoteService.FUNDAMENTAL_FIELDS,
    };

    /** 字段编号 -> 中文名称映射 */
    private static readonly CODE_NAME_MAP: Record<string, string> = {
        'f57': '股票代码',
        'f58': '股票简称',
        'f43': '最新价',
        'f86': '更新时间',  /*原始为Unix秒级时间戳，返回时已转换为可读格式*/
        'f44': '最高价',
        'f45': '最低价',
        'f60': '昨收价',
        'f46': '今开价',
        'f51': '涨停价',
        'f52': '跌停价',
        'f169': '涨跌额',
        'f170': '涨跌幅',
        'f71': '均价',
        'f50': '量比',
        'f47': '成交量',     /*原始单位为手(1手=100股)，返回时已转换为股*/
        'f48': '成交额',     /*单位为：元*/
        'f168': '换手率',
        'f161': '内盘',      /*原始单位为手，返回时已转换为股*/
        'f49': '外盘',       /*原始单位为手，返回时已转换为股*/
        'f167': '市净率',
        'f173': 'ROE',
        'f183': '总营收',
        'f184': '总营收-同比',
        'f185': '净利润-同比',
        'f186': '毛利率',
        'f187': '净利率',
        'f188': '负债率',
        'f190': '每股未分配利润',
        'f162': '动态市盈率',
        'f92': '每股净资产',
        'f55': '季度收益',
        'f105': '净利润',
        'f84': '总股本',
        'f85': '流通股',
        'f116': '总市值',
        'f117': '流通市值'
    };

    /**
     * 获取单只股票实时行情
     * @param symbol 6位股票代码
     * @param level 查询级别，默认 core
     */
    static async getQuote(symbol: string, level: QuoteLevel = 'core'): Promise<Record<string, any>> {
        const identity = getStockIdentity(symbol);
        const { eastmoneyId } = identity;
        const fields = this.LEVEL_FIELDS[level];

        const url = `${this.BASE_URL}?invt=2&fltt=2&fields=${fields}&secid=${eastmoneyId}.${symbol}`;
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
                let value = innerData[key];

                if (VOLUME_FIELDS.has(key) && typeof value === 'number') {
                    value = value * 100; // 手 -> 股（1手 = 100股）
                } else if (key === 'f86' && typeof value === 'number') {
                    value = formatToChinaTime(value * 1000); // Unix秒 -> 毫秒 -> 可读格式
                }

                result[name] = value;
            }
        }

        return result;
    }

    /**
     * 批量获取股票实时行情
     * 使用 Promise.allSettled 保证部分失败不影响整体结果
     * @param symbols 股票代码数组
     * @param level 查询级别，默认 core
     */
    static async getBatchQuotes(symbols: string[], level: QuoteLevel = 'core'): Promise<Record<string, any>[]> {
        const results = await Promise.allSettled(
            symbols.map(symbol => this.getQuote(symbol, level))
        );

        return results.map((result, index) => {
            if (result.status === 'fulfilled') {
                return result.value;
            }
            return {
                '股票代码': symbols[index],
                '错误': result.reason?.message || '查询失败',
            };
        });
    }
}
