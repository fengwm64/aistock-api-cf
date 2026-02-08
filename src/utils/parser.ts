export function parseTable($: any, tableElement: any, type: string): any[] {
    const rows = $(tableElement).find("tr");
    const data: any[] = [];
    
    // Determine headers
    
    let headers: string[] = [];
    // Helper to get text from cell
    const getText = (el: any) => $(el).text().trim();

    if (type === "业绩预测详表-机构") {
        const headerRows = $(tableElement).find("thead tr");
        // We expect at least 2 header rows for this table type
        if (headerRows.length >= 2) {
             const row0Cells = $(headerRows[0]).find("th, td");
             let epsHeaderName = "预测年报每股收益";
             let profitHeaderName = "预测年报净利润";

             row0Cells.each((_: any, el: any) => {
                 const txt = getText(el);
                 if (txt.includes("每股收益")) epsHeaderName = txt;
                 if (txt.includes("净利润")) profitHeaderName = txt;
             });

             const row1Cells = $(headerRows[1]).find("th, td");
             // Expecting sub-headers for EPS (3 cols) and Profit (3 cols)
             
             const yearsEPS = [
                 getText(row1Cells[0]),
                 getText(row1Cells[1]),
                 getText(row1Cells[2])
             ];
             const yearsProfit = [
                 getText(row1Cells[3]),
                 getText(row1Cells[4]),
                 getText(row1Cells[5])
             ];

             const tbody = $(tableElement).find("tbody");
             const dataRows = tbody.length > 0 ? tbody.find("tr") : $(tableElement).find("tr").slice(headerRows.length);
             
             dataRows.each((_: any, row: any) => {
                 const cells = $(row).find("th, td");
                 // Data rows should have 9 columns:
                 // 0: 机构名称, 1: 研究员, 2-4: EPS data, 5-7: Profit data, 8: 报告日期
                 if (cells.length < 9) return;

                 const item: any = {};
                 item["机构名称"] = getText(cells[0]);
                 item["研究员"] = getText(cells[1]);
                 
                 item[epsHeaderName] = {};
                 item[epsHeaderName][yearsEPS[0]] = getText(cells[2]);
                 item[epsHeaderName][yearsEPS[1]] = getText(cells[3]);
                 item[epsHeaderName][yearsEPS[2]] = getText(cells[4]);
                 
                 item[profitHeaderName] = {};
                 item[profitHeaderName][yearsProfit[0]] = getText(cells[5]);
                 item[profitHeaderName][yearsProfit[1]] = getText(cells[6]);
                 item[profitHeaderName][yearsProfit[2]] = getText(cells[7]);
                 
                 item["报告日期"] = getText(cells[8]);
                 
                 data.push(item);
             });
        } else {
             // Fallback to flat if structure is unexpected
             const allRows = $(tableElement).find("tr");
             const dataRows = allRows.slice(1); 
             
             const headers: string[] = [];
             $(allRows[0]).find("th, td").each((_: any, cell: any) => headers.push(getText(cell)));

             dataRows.each((_: any, row: any) => {
                 const cells = $(row).find("th, td");
                 const rowObj: any = {};
                 cells.each((idx: number, cell: any) => {
                     if (headers[idx]) rowObj[headers[idx]] = getText(cell);
                 });
                 data.push(rowObj);
             });
        }
        
    } else {
        // Standard tables
        let headerRow = $(tableElement).find("thead tr").last();
        if (headerRow.length === 0) headerRow = $(tableElement).find("tr").first();

        headerRow.find("th, td").each((_: any, cell: any) => {
            headers.push(getText(cell));
        });
        
        const tbody = $(tableElement).find("tbody");
        let dataRows = tbody.length > 0 ? tbody.find("tr") : $(tableElement).find("tr").slice(1);

        dataRows.each((_: any, row: any) => {
             const cells = $(row).find("th, td");
            if (cells.length === 0) return;

             const rowObj: any = {};
             cells.each((idx: number, cell: any) => {
                 if (headers[idx]) {
                     rowObj[headers[idx]] = getText(cell);
                 }
             });
             if (Object.keys(rowObj).length > 0) data.push(rowObj);
        });
    }
    
    return data;
}
