/**
 * A股代码校验工具
 */

/**
 * 校验 A 股股票代码格式（6位数字）
 */
export function isValidAShareSymbol(symbol: string): boolean {
    return /^\d{6}$/.test(symbol);
}

/**
 * 校验全球指数代码格式（字母数字组合，1-10位）
 */
export function isValidGlobalIndexSymbol(symbol: string): boolean {
    return /^[A-Z0-9]{1,10}$/i.test(symbol);
}

/**
 * 校验板块代码格式（BK + 4位数字）
 */
export function isValidTagCode(tagCode: string): boolean {
    return /^BK\d{4}$/i.test(tagCode);
}
