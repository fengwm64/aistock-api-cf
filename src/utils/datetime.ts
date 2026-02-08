/**
 * 日期时间工具函数
 */

/**
 * 将时间戳格式化为中国时间（UTC+8）字符串
 * @param timestamp Unix 毫秒时间戳
 * @returns 格式如 "2026-02-08 12:08:16"
 */
export function formatToChinaTime(timestamp: number): string {
    const date = new Date(timestamp);
    const utc8Time = date.getTime() + (date.getTimezoneOffset() * 60000) + (8 * 3600000);
    const d = new Date(utc8Time);

    const pad = (n: number) => n.toString().padStart(2, '0');

    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
