import { ThsService } from '../services/ThsService';
import { createResponse } from '../utils/response';
import { formatToChinaTime } from '../utils/datetime';
import { Env } from '../index';

/**
 * 盈利预测控制器
 */
export class ProfitForecastController {
    /**
     * 生成中国时区时间（带毫秒），避免同一秒重复写入触发复合主键冲突
     */
    private static formatToChinaTimeWithMs(timestamp: number): string {
        const date = new Date(timestamp);
        const utc8Time = date.getTime() + (date.getTimezoneOffset() * 60000) + (8 * 3600000);
        const d = new Date(utc8Time);

        const pad2 = (n: number) => n.toString().padStart(2, '0');
        const pad3 = (n: number) => n.toString().padStart(3, '0');

        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
            `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
    }

    static async getThsForecast(symbol: string, env: Env, ctx: ExecutionContext) {
        if (!symbol) {
            return createResponse(400, '缺少 symbol 参数');
        }

        const source = `同花顺 https://basic.10jqka.com.cn/new/${symbol}/worth.html`;

        try {
            const data = await ThsService.getProfitForecast(symbol);
            const now = Date.now();
            const updateTime = this.formatToChinaTimeWithMs(now);

            // 写入 D1（仅保留摘要 + 详细指标预测）
            await env.DB
                .prepare(
                    `INSERT INTO earnings_forecast
                        (symbol, update_time, summary, forecast_detail)
                     VALUES
                        (?1, ?2, ?3, ?4)`
                )
                .bind(
                    symbol,
                    updateTime,
                    typeof data['摘要'] === 'string' ? data['摘要'] : '',
                    JSON.stringify(data['业绩预测详表_详细指标预测'] ?? []),
                )
                .run();

            return createResponse(200, 'success', {
                '股票代码': symbol,
                '来源': source,
                '更新时间': formatToChinaTime(now),
                ...data,
            });
        } catch (error: any) {
            return createResponse(500, error.message);
        }
    }
}
