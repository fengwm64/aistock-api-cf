/**
 * A股代码校验工具
 */

/**
 * 校验 A 股股票代码格式（6位数字）
 */
export function isValidAShareSymbol(symbol: string): boolean {
    return /^\d{6}$/.test(symbol);
}
