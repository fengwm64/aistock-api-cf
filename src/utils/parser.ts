/**
 * HTML 表格解析工具
 * 用于解析同花顺等数据源的 HTML 表格
 */

type CheerioStatic = ReturnType<typeof import('cheerio').load>;
type CheerioElement = any;

/** 解析表格数据 */
const getText = ($: CheerioStatic, el: CheerioElement): string => $(el).text().trim();

/**
 * 解析业绩预测详表（机构）—— 复杂多行表头
 */
function parseInstitutionTable($: CheerioStatic, tableElement: CheerioElement): Record<string, any>[] {
    const data: Record<string, any>[] = [];
    const headerRows = $(tableElement).find('thead tr');

    if (headerRows.length < 2) {
        return parseFlatTable($, tableElement);
    }

    // 提取两层表头
    const row0Cells = $(headerRows[0]).find('th, td');
    let epsHeaderName = '预测年报每股收益';
    let profitHeaderName = '预测年报净利润';

    row0Cells.each((_: number, el: CheerioElement) => {
        const txt = getText($, el);
        if (txt.includes('每股收益')) epsHeaderName = txt;
        if (txt.includes('净利润')) profitHeaderName = txt;
    });

    const row1Cells = $(headerRows[1]).find('th, td');
    const yearsEPS = [0, 1, 2].map(i => getText($, row1Cells[i]));
    const yearsProfit = [3, 4, 5].map(i => getText($, row1Cells[i]));

    // 解析数据行
    const tbody = $(tableElement).find('tbody');
    const dataRows = tbody.length > 0
        ? tbody.find('tr')
        : $(tableElement).find('tr').slice(headerRows.length);

    dataRows.each((_: number, row: CheerioElement) => {
        const cells = $(row).find('th, td');
        if (cells.length < 9) return;

        const item: Record<string, any> = {
            '机构名称': getText($, cells[0]),
            '研究员': getText($, cells[1]),
            [epsHeaderName]: {
                [yearsEPS[0]]: getText($, cells[2]),
                [yearsEPS[1]]: getText($, cells[3]),
                [yearsEPS[2]]: getText($, cells[4]),
            },
            [profitHeaderName]: {
                [yearsProfit[0]]: getText($, cells[5]),
                [yearsProfit[1]]: getText($, cells[6]),
                [yearsProfit[2]]: getText($, cells[7]),
            },
            '报告日期': getText($, cells[8]),
        };

        data.push(item);
    });

    return data;
}

/**
 * 解析普通平铺表格
 */
function parseFlatTable($: CheerioStatic, tableElement: CheerioElement): Record<string, any>[] {
    const data: Record<string, any>[] = [];
    const headers: string[] = [];

    let headerRow = $(tableElement).find('thead tr').last();
    if (headerRow.length === 0) {
        headerRow = $(tableElement).find('tr').first();
    }

    headerRow.find('th, td').each((_: number, cell: CheerioElement) => {
        headers.push(getText($, cell));
    });

    const tbody = $(tableElement).find('tbody');
    const dataRows = tbody.length > 0
        ? tbody.find('tr')
        : $(tableElement).find('tr').slice(1);

    dataRows.each((_: number, row: CheerioElement) => {
        const cells = $(row).find('th, td');
        if (cells.length === 0) return;

        const rowObj: Record<string, string> = {};
        cells.each((idx: number, cell: CheerioElement) => {
            if (headers[idx]) {
                rowObj[headers[idx]] = getText($, cell);
            }
        });

        if (Object.keys(rowObj).length > 0) {
            data.push(rowObj);
        }
    });

    return data;
}

/**
 * 解析业绩预测详表-详细指标预测
 * 需要去除嵌套表格，并处理表头括号
 */
function parseDetailedForecastTable($: CheerioStatic, tableElement: CheerioElement): Record<string, any>[] {
    const data: Record<string, any>[] = [];
    const headers: string[] = [];

    // 获取清洗后的文本（跳过嵌套表格内容）
    const getCleanText = (el: CheerioElement): string => {
        // 预测列的值在 div.pr > span 中，优先提取
        const prSpan = $(el).find('div.pr > span');
        if (prSpan.length > 0) {
            return prSpan.first().text().trim();
        }
        // 普通列：直接取文本
        let text = '';
        $(el).contents().each((_: number, child: CheerioElement) => {
            if (child.type === 'text') {
                text += child.data || '';
            } else if (child.type === 'tag' && child.name !== 'table' && child.name !== 'div') {
                text += $(child).text();
            }
        });
        return text.replace(/\s+/g, '');
    };

    let headerRow = $(tableElement).children('thead').children('tr').last();
    if (headerRow.length === 0) {
        headerRow = $(tableElement).children('tbody').children('tr').first();
    }
    if (headerRow.length === 0) {
        headerRow = $(tableElement).children('tr').first();
    }

    headerRow.children('th, td').each((_: number, cell: CheerioElement) => {
        let text = getCleanText(cell);
        // 替换括号为短横线
        text = text.replace(/（/g, '-').replace(/）/g, '').replace(/\(/g, '-').replace(/\)/g, '');
        // 简单清洗空白字符
        text = text.replace(/\s+/g, ''); 
        if(text) headers.push(text);
    });

    // 优先从 tbody 查找直接子行
    let dataRows = $(tableElement).children('tbody').children('tr');
    if (dataRows.length === 0) {
        // 如果没有 tbody，则查找 table 的直接子 tr，并排除第一行（如果是表头）
        dataRows = $(tableElement).children('tr').slice(1);
    }

    dataRows.each((_: number, row: CheerioElement) => {
        // 只查找当前行的直接子单元格
        const cells = $(row).children('th, td');
        if (cells.length === 0) return;

        const rowObj: Record<string, string> = {};
        cells.each((idx: number, cell: CheerioElement) => {
            if (headers[idx]) {
                rowObj[headers[idx]] = getCleanText(cell);
            }
        });

        if (Object.keys(rowObj).length > 0) {
            data.push(rowObj);
        }
    });

    return data;
}

/**
 * 解析 HTML 表格元素
 * @param $ cheerio 实例
 * @param tableElement 表格 DOM 元素
 * @param type 表格类型标识
 */
export function parseTable($: CheerioStatic, tableElement: CheerioElement, type: string): Record<string, any>[] {
    if (type === '业绩预测详表-机构') {
        return parseInstitutionTable($, tableElement);
    }
    if (type === '业绩预测详表-详细指标预测') {
        return parseDetailedForecastTable($, tableElement);
    }
    return parseFlatTable($, tableElement);
}
