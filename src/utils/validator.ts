/**
 * 校验 A 股股票代码格式
 * A 股代码通常为 6 位数字
 * @param symbol 股票代码
 * @returns boolean
 */
export function isValidAShareSymbol(symbol: string): boolean {
    // 必须是 6 位数字
    return /^\d{6}$/.test(symbol);
}
