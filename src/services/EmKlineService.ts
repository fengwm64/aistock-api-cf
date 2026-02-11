import { getStockIdentity } from '../utils/stock';
import { eastmoneyThrottler } from '../utils/throttlers';

/** K 线周期 */
export type KLinePeriod = 1 | 5 | 15 | 30 | 60 | 101 | 102 | 103;

/** 复权类型 */
export type KLineFqt = 0 | 1 | 2;

export interface KLineOptions {
    symbol: string;
    klt?: KLinePeriod;
    fqt?: KLineFqt;
    limit?: number;
    startDate?: string;
    endDate?: string;
}

/** 东方财富 K 线服务 */
export class EmKlineService {
    private static readonly BASE_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';

    private static readonly HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://quote.eastmoney.com/',
    };

    private static toNumber(value: string): number | null {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }

    private static parseKLineRow(line: string): Record<string, any> | null {
        const parts = line.split(',');
        if (parts.length < 11) return null;

        return {
            '时间': parts[0],
            '开盘价': this.toNumber(parts[1]),
            '收盘价': this.toNumber(parts[2]),
            '最高价': this.toNumber(parts[3]),
            '最低价': this.toNumber(parts[4]),
            '成交量': this.toNumber(parts[5]),
            '成交额': this.toNumber(parts[6]),
            '振幅': this.toNumber(parts[7]),
            '涨跌幅': this.toNumber(parts[8]),
            '涨跌额': this.toNumber(parts[9]),
            '换手率': this.toNumber(parts[10]),
        };
    }

    static async getKLine(options: KLineOptions): Promise<Record<string, any>[]> {
        const {
            symbol,
            klt = 101,
            fqt = 1,
            limit = 1000,
            startDate,
            endDate,
        } = options;

        const identity = getStockIdentity(symbol);
        const secid = `${identity.eastmoneyId}.${symbol}`;

        const url = new URL(this.BASE_URL);
        url.searchParams.set('secid', secid);
        url.searchParams.set('klt', String(klt));
        url.searchParams.set('fqt', String(fqt));
        url.searchParams.set('lmt', String(limit));
        url.searchParams.set('end', endDate || '20500101');
        url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6');
        url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61');
        url.searchParams.set('_', String(Date.now()));

        if (startDate) {
            url.searchParams.set('beg', startDate);
        }

        // 限流 (东方财富)
        await eastmoneyThrottler.throttle();

        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: this.HEADERS,
        });

        if (!response.ok) {
            throw new Error(`东方财富 K 线接口请求失败: ${response.status}`);
        }

        const json: any = await response.json();
        const klineRows: unknown = json?.data?.klines;

        if (!Array.isArray(klineRows)) {
            return [];
        }

        return klineRows
            .map(line => typeof line === 'string' ? this.parseKLineRow(line) : null)
            .filter((item): item is Record<string, any> => item !== null);
    }
}
