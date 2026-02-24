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
    private static readonly BASE_URL = 'https://62.push2his.eastmoney.com/api/qt/stock/kline/get';
    private static readonly UT = 'fa5fd1943c7b386f172d6893dbfba10b';
    private static readonly RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
    private static readonly MAX_RETRIES = 3;
    private static readonly RETRY_BASE_DELAY_MS = 300;

    private static readonly USER_AGENT =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0';

    private static async sleep(ms: number): Promise<void> {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
    }

    private static buildBrowserLikeHeaders(): Record<string, string> {
        return {
            'User-Agent': this.USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'DNT': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'sec-ch-ua': '"Not:A-Brand";v="99", "Microsoft Edge";v="145", "Chromium";v="145"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"macOS"',
        };
    }

    private static buildKlineUrl(options: KLineOptions): URL {
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
        url.searchParams.set('ut', this.UT);
        url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6');
        url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61');
        url.searchParams.set('_', String(Date.now()));

        if (startDate) {
            url.searchParams.set('beg', startDate);
        }

        return url;
    }

    private static async fetchKlineJson(url: URL): Promise<any> {
        let lastError: Error | null = null;
        const headers = this.buildBrowserLikeHeaders();

        for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
            // 限流 (东方财富)
            await eastmoneyThrottler.throttle();

            try {
                const response = await fetch(url.toString(), {
                    method: 'GET',
                    headers,
                });

                if (response.ok) {
                    return await response.json();
                }

                const status = response.status;
                const bodyText = await response.text().catch(() => '');
                const snippet = bodyText.replace(/\s+/g, ' ').slice(0, 180);
                const message = snippet
                    ? `东方财富 K 线接口请求失败: ${status} ${snippet}`
                    : `东方财富 K 线接口请求失败: ${status}`;
                lastError = new Error(message);

                if (!this.RETRYABLE_STATUS.has(status) || attempt === this.MAX_RETRIES) {
                    throw lastError;
                }
            } catch (err) {
                const wrapped = err instanceof Error ? err : new Error(String(err));
                lastError = wrapped;
                if (attempt === this.MAX_RETRIES) {
                    throw new Error(`${wrapped.message} (url=${url.toString()})`);
                }
            }

            await this.sleep(this.RETRY_BASE_DELAY_MS * attempt);
        }

        throw new Error(`东方财富 K 线接口请求失败: 未知错误 (url=${url.toString()})`);
    }

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
        const url = this.buildKlineUrl(options);
        const json: any = await this.fetchKlineJson(url);
        const klineRows: unknown = json?.data?.klines;

        if (!Array.isArray(klineRows)) {
            return [];
        }

        return klineRows
            .map(line => typeof line === 'string' ? this.parseKLineRow(line) : null)
            .filter((item): item is Record<string, any> => item !== null);
    }
}
