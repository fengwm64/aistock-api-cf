/**
 * API 限流器实例
 * 
 * 为不同数据源创建独立的限流器，避免跨数据源的不必要限流
 */

import { createThrottler, DEFAULT_THROTTLE_MS } from './throttle';

/**
 * 同花顺 (THS) 限流器
 * 用于: ThsService
 */
export const thsThrottler = createThrottler(DEFAULT_THROTTLE_MS);

/**
 * 东方财富 (Eastmoney) 限流器
 * 用于: EmInfoService, EmQuoteService, EmStockRankService, IndexQuoteController
 */
export const eastmoneyThrottler = createThrottler(DEFAULT_THROTTLE_MS);

/**
 * 财联社 (Cailianpress) 限流器
 * 用于: NewsController
 */
export const cailianpressThrottler = createThrottler(DEFAULT_THROTTLE_MS);
