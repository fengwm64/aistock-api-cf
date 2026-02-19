/**
 * A 股交易时间判断工具
 *
 * 规则：
 * 1. 仅周一至周五可交易（周末恒休市）。
 * 2. 法定节假日休市（通过 timor.tech API 判断）。
 * 3. 交易时间窗口（北京时间）：
 *    - 09:15:00 - 09:25:00（集合竞价）
 *    - 09:30:00 - 11:30:00（上午连续交易）
 *    - 13:00:00 - 15:00:00（下午连续交易）
 */

const TIMOR_HOLIDAY_API_BASE = 'https://timor.tech/api/holiday/info/';
const HOLIDAY_REQUEST_TIMEOUT_MS = 3500;
const INDEX_QUOTE_TRADING_TTL_BASE_SECONDS = 5;
const INDEX_QUOTE_TRADING_TTL_JITTER_SECONDS = 5;
const TRADING_OPEN_HOUR = 9;
const TRADING_OPEN_MINUTE = 15;
const NEXT_TRADING_SEARCH_MAX_DAYS = 30;

interface HolidayApiResponse {
    code: number;
    holiday: {
        holiday: boolean;
        name?: string;
        wage?: number;
        after?: boolean;
        target?: string;
    } | null;
}

interface ChinaDateTimeParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
}

export interface AShareTradingTimeOptions {
    now?: Date | number;
    fetcher?: typeof fetch;
}

const chinaDateFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
});

const holidayCache = new Map<string, boolean>();

function parseChinaDateTimeParts(date: Date): ChinaDateTimeParts {
    const parts = chinaDateFormatter.formatToParts(date);
    const partMap: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};

    for (const part of parts) {
        if (part.type !== 'literal') {
            partMap[part.type] = part.value;
        }
    }

    const year = Number(partMap.year);
    const month = Number(partMap.month);
    const day = Number(partMap.day);
    const hour = Number(partMap.hour);
    const minute = Number(partMap.minute);
    const second = Number(partMap.second);

    if (![year, month, day, hour, minute, second].every(Number.isFinite)) {
        throw new Error('Failed to parse China time components');
    }

    return { year, month, day, hour, minute, second };
}

function formatDateKey(parts: Pick<ChinaDateTimeParts, 'year' | 'month' | 'day'>): string {
    const pad = (value: number) => value.toString().padStart(2, '0');
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function isWeekendInChina(parts: Pick<ChinaDateTimeParts, 'year' | 'month' | 'day'>): boolean {
    // 星期几与时区无关，使用日期本身计算即可。
    const weekDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    return weekDay === 0 || weekDay === 6;
}

function isWithinTradingWindows(parts: Pick<ChinaDateTimeParts, 'hour' | 'minute' | 'second'>): boolean {
    const seconds = parts.hour * 3600 + parts.minute * 60 + parts.second;

    const inAuction = seconds >= (9 * 3600 + 15 * 60) && seconds <= (9 * 3600 + 25 * 60);
    const inMorning = seconds >= (9 * 3600 + 30 * 60) && seconds <= (11 * 3600 + 30 * 60);
    const inAfternoon = seconds >= (13 * 3600) && seconds <= (15 * 3600);

    return inAuction || inMorning || inAfternoon;
}

function isClosingRefreshMoment(parts: Pick<ChinaDateTimeParts, 'hour' | 'minute'>): boolean {
    // 15:00 这一轮刷新希望将 TTL 拉长至下一交易日 9:15
    return parts.hour === 15 && parts.minute === 0;
}

function addCalendarDays(
    parts: Pick<ChinaDateTimeParts, 'year' | 'month' | 'day'>,
    offset: number,
): Pick<ChinaDateTimeParts, 'year' | 'month' | 'day'> {
    const utcDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset));
    return {
        year: utcDate.getUTCFullYear(),
        month: utcDate.getUTCMonth() + 1,
        day: utcDate.getUTCDate(),
    };
}

function chinaDateTimeToTimestampMs(
    parts: Pick<ChinaDateTimeParts, 'year' | 'month' | 'day'>,
    hour: number,
    minute: number,
    second = 0,
): number {
    // 中国时间 = UTC+8
    return Date.UTC(parts.year, parts.month - 1, parts.day, hour - 8, minute, second);
}

async function isChinaHoliday(dateKey: string, fetcher: typeof fetch): Promise<boolean> {
    const cached = holidayCache.get(dateKey);
    if (cached !== undefined) return cached;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HOLIDAY_REQUEST_TIMEOUT_MS);

    try {
        const response = await fetcher(`${TIMOR_HOLIDAY_API_BASE}${dateKey}`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
            },
            signal: controller.signal,
        });

        if (!response.ok) {
            console.error(`[TradingTime] Holiday API failed: ${response.status}`);
            return true; // 保守策略：节假日服务不可用时视为非交易时段
        }

        const data = await response.json() as HolidayApiResponse;
        if (data.code !== 0) {
            console.error(`[TradingTime] Holiday API returned code: ${data.code}`);
            return true;
        }

        const isHoliday = Boolean(data.holiday && data.holiday.holiday === true);
        holidayCache.set(dateKey, isHoliday);
        return isHoliday;
    } catch (err) {
        console.error('[TradingTime] Holiday API request error:', err);
        return true;
    } finally {
        clearTimeout(timer);
    }
}

async function getSecondsUntilNextTradingOpen(date: Date, fetcher: typeof fetch): Promise<number> {
    const nowMs = date.getTime();
    const chinaParts = parseChinaDateTimeParts(date);
    const today = { year: chinaParts.year, month: chinaParts.month, day: chinaParts.day };

    for (let offset = 0; offset <= NEXT_TRADING_SEARCH_MAX_DAYS; offset++) {
        const candidate = addCalendarDays(today, offset);

        if (isWeekendInChina(candidate)) {
            continue;
        }

        const candidateDateKey = formatDateKey(candidate);
        const holiday = await isChinaHoliday(candidateDateKey, fetcher);
        if (holiday) {
            continue;
        }

        const openMs = chinaDateTimeToTimestampMs(candidate, TRADING_OPEN_HOUR, TRADING_OPEN_MINUTE, 0);
        if (openMs <= nowMs) {
            continue;
        }

        return Math.max(1, Math.ceil((openMs - nowMs) / 1000));
    }

    console.warn('[TradingTime] failed to locate next trading open day, fallback to 12h');
    return 12 * 60 * 60;
}

/**
 * 判断当前（或指定时间）是否处于 A 股交易时段（北京时间）。
 */
export async function isAShareTradingTime(options: AShareTradingTimeOptions = {}): Promise<boolean> {
    const nowInput = options.now ?? Date.now();
    const nowDate = nowInput instanceof Date ? nowInput : new Date(nowInput);
    const fetcher = options.fetcher ?? fetch;

    if (Number.isNaN(nowDate.getTime())) {
        throw new Error('Invalid date input');
    }

    const chinaParts = parseChinaDateTimeParts(nowDate);

    if (isWeekendInChina(chinaParts)) {
        return false;
    }

    if (!isWithinTradingWindows(chinaParts)) {
        return false;
    }

    const dateKey = formatDateKey(chinaParts);
    const holiday = await isChinaHoliday(dateKey, fetcher);
    return !holiday;
}

/**
 * 计算指数缓存 TTL：
 * - 交易时段：5s + 随机扰动（0~5s）
 * - 15:00 最后一轮刷新：拉长到下一交易日 09:15
 * - 非交易时段：拉长到下一交易日 09:15
 */
export async function getAShareIndexCacheTtlSeconds(options: AShareTradingTimeOptions = {}): Promise<number> {
    const nowInput = options.now ?? Date.now();
    const nowDate = nowInput instanceof Date ? nowInput : new Date(nowInput);
    const fetcher = options.fetcher ?? fetch;

    if (Number.isNaN(nowDate.getTime())) {
        throw new Error('Invalid date input');
    }

    const chinaParts = parseChinaDateTimeParts(nowDate);
    const dateKey = formatDateKey(chinaParts);
    const weekend = isWeekendInChina(chinaParts);
    const holiday = weekend ? true : await isChinaHoliday(dateKey, fetcher);
    const inTradingWindows = isWithinTradingWindows(chinaParts);

    if (!weekend && !holiday && inTradingWindows && !isClosingRefreshMoment(chinaParts)) {
        return INDEX_QUOTE_TRADING_TTL_BASE_SECONDS + Math.floor(Math.random() * (INDEX_QUOTE_TRADING_TTL_JITTER_SECONDS + 1));
    }

    return getSecondsUntilNextTradingOpen(nowDate, fetcher);
}
