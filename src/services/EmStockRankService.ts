/**
 * 东方财富个股人气榜服务
 * 数据源: https://guba.eastmoney.com/rank/
 */

interface RankItem {
    sc: string;  // 股票代码 (如 "SZ000001")
    rk: number;  // 排名
}

export interface StockRankResult {
    当前排名: number;
    股票代码: string;
}

export class EmStockRankService {
    /** 人气榜排名接口 */
    private static readonly RANK_URL = 'https://emappdata.eastmoney.com/stockrank/getAllCurrentList';

    /**
     * 获取个股人气榜 Top 100（仅排名和代码）
     */
    static async getStockHotRank(): Promise<StockRankResult[]> {
        const response = await fetch(this.RANK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                appId: 'appId01',
                globalId: '786e4c21-70dc-435a-93bb-38',
                marketType: '',
                pageNo: 1,
                pageSize: 100,
            }),
        });

        if (!response.ok) {
            throw new Error(`人气榜接口请求失败: ${response.status}`);
        }

        const json: any = await response.json();
        const data: RankItem[] = json.data;

        if (!Array.isArray(data) || data.length === 0) {
            throw new Error('人气榜接口返回数据为空');
        }

        return data.map(item => ({
            '当前排名': Number(item.rk),
            '股票代码': item.sc.replace(/^(SZ|SH|BJ)/i, ''),
        }));
    }
}
