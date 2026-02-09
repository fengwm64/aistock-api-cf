export interface StockIdentity {
    market: 'sh' | 'sz' | 'bj' | 'unknown';
    board: string;
    eastmoneyId: 0 | 1;
}

/**
 * 根据股票代码解析市场和板块信息
 * 
 * 规则细化：
 * 【上海交所】(eastmoneyId: 1)
 * - 600, 601, 603: 沪市主板
 * - 688: 科创板
 * - 900: 沪市B股
 * 
 * 【深圳交易所】(eastmoneyId: 0)
 * - 000, 001: 深市主板
 * - 002, 003: 中小板
 * - 300: 创业板
 * - 200: 深市B股
 * 
 * 【北京交易所】(eastmoneyId: 0)
 * - 920: 北交所
 * 
 * @param symbol 6位股票代码
 */
export function getStockIdentity(symbol: string): StockIdentity {
    // 上海证券交易所
    if (symbol.startsWith('600') || symbol.startsWith('601') || symbol.startsWith('603')) {
        return { market: 'sh', board: '沪市主板', eastmoneyId: 1 };
    }
    if (symbol.startsWith('688')) {
        return { market: 'sh', board: '科创板', eastmoneyId: 1 };
    }
    if (symbol.startsWith('900')) {
        return { market: 'sh', board: '沪市B股', eastmoneyId: 1 };
    }

    // 深圳证券交易所
    if (symbol.startsWith('000') || symbol.startsWith('001')) {
        return { market: 'sz', board: '深市主板', eastmoneyId: 0 };
    }
    if (symbol.startsWith('002') || symbol.startsWith('003')) {
        return { market: 'sz', board: '中小板', eastmoneyId: 0 };
    }
    if (symbol.startsWith('300')) {
        return { market: 'sz', board: '创业板', eastmoneyId: 0 };
    }
    if (symbol.startsWith('200')) {
        return { market: 'sz', board: '深市B股', eastmoneyId: 0 };
    }

    // 北京证券交易所 (920开头)
    if (symbol.startsWith('920')) {
        return { market: 'bj', board: '北交所', eastmoneyId: 0 };
    }

    return { market: 'unknown', board: '未知板块', eastmoneyId: 1 };
}
