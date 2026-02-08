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
 * 解析 HTML 表格元素
 * @param $ cheerio 实例
 * @param tableElement 表格 DOM 元素
 * @param type 表格类型标识
 */
export function parseTable($: CheerioStatic, tableElement: CheerioElement, type: string): Record<string, any>[] {
    if (type === '业绩预测详表-机构') {
        return parseInstitutionTable($, tableElement);
    }
    return parseFlatTable($, tableElement);
}
