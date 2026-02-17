# AIStock API

A 股数据 API，基于 Cloudflare Workers 构建，提供股票基本信息、股票实时行情、指数实时行情、盈利预测、热门人气榜、新闻头条、个股新闻、个股 AI 评价、自选股图片 OCR 识别等接口。

## 架构

```
src/
├── index.ts                        # 入口 & 路由分发
├── controllers/                    # 控制器层：参数校验、缓存逻辑、响应组装
│   ├── StockListController.ts      # A股列表查询
│   ├── StockInfoController.ts      # 股票基本信息
│   ├── StockQuoteController.ts     # 股票实时行情
│   ├── IndexQuoteController.ts     # 指数实时行情
│   ├── StockRankController.ts      # 热门人气榜
│   ├── ProfitForecastController.ts # 盈利预测
│   ├── NewsController.ts           # 新闻头条/个股新闻/新闻详情
│   ├── StockAnalysisController.ts  # 个股 AI 评价
│   └── StockOcrController.ts       # 自选股图片 OCR
├── services/                       # 服务层：核心业务逻辑 & 外部数据源请求
│   ├── EmService.ts                # 东方财富 - 股票基本信息
│   ├── EmQuoteService.ts           # 东方财富 - 股票实时行情
│   ├── EmStockRankService.ts       # 东方财富 - 人气榜排名
│   ├── ThsService.ts               # 同花顺 - 盈利预测
│   ├── ClsStockNewsService.ts      # 财联社 - 个股新闻复用服务
│   ├── StockAnalysisService.ts     # 个股 AI 评价聚合 + 大模型调用
│   ├── StockOcrService.ts          # 自选股图片 OCR + VLM 调用
│   └── CacheService.ts             # KV 缓存封装
└── utils/                          # 工具层
    ├── response.ts                 # 统一响应格式
    ├── validator.ts                # A 股代码校验
    ├── stock.ts                    # 股票市场/板块识别
    ├── datetime.ts                 # 日期时间格式化
    ├── throttle.ts                 # 限流工具（基础实现）
    ├── throttlers.ts               # 按数据源分组的限流器实例
    └── parser.ts                   # HTML 表格解析
```

### 分层设计

| 层级 | 职责 | 示例 |
|------|------|------|
| **路由层** (`index.ts`) | URL 匹配、参数提取、方法校验 | `GET /api/cn/stock/infos?symbols=000001` |
| **控制器层** (`controllers/`) | 参数校验、缓存读写、响应组装 | 缓存命中返回 `success (cached)` |
| **服务层** (`services/`) | 外部 API 调用、数据转换 | 请求东方财富/同花顺接口 |
| **工具层** (`utils/`) | 通用函数，无业务逻辑 | 日期格式化、代码校验 |

### 技术栈

- **Runtime**: Cloudflare Workers
- **Language**: TypeScript
- **Database**: Cloudflare D1 (SQLite)
  - 使用 Sessions API 实现全球读复制
  - 支持顺序一致性保证
  - 覆盖 ENAM、WNAM、WEUR、EEUR、APAC、OC 等区域
- **Cache**: Cloudflare Workers KV
- **HTML Parsing**: cheerio
- **Encoding**: TextDecoder (GBK)
- **Rate Limiting**: 按数据源分组的独立限流器
  - 同花顺 (THS): 独立限流，默认 300ms
  - 东方财富 (Eastmoney): 独立限流，默认 300ms（所有东财接口共享）
  - 财联社 (Cailianpress): 独立限流，默认 300ms

---

## API 接口

接口以 `GET` 为主，部分接口支持 `POST` / `DELETE`。统一响应格式：

```json
{
  "code": 200,
  "message": "success",
  "data": { ... }
}
```

### 1. A股列表查询

从 D1 数据库查询 A 股列表，支持全量分页、关键词搜索、精确查询和组合筛选。

**使用 D1 读复制（Read Replication）**：此接口使用 D1 Sessions API 实现全球读复制，通过将查询路由到离用户更近的只读副本来降低延迟并提高读取吞吐量。

**性能优化建议**：
- 已为 `market` 列创建索引，市场筛选查询性能优秀
- `symbol` 精确查询使用主键索引，性能最优
- `keyword` 搜索使用 `LIKE '%keyword%'` 会进行全表扫描，建议限制搜索频率或结合 market 参数使用
- 详见 [D1 性能优化指南](docs/D1_PERFORMANCE_OPTIMIZATION.md)

- **URL**: `/api/cn/stocks`
- **参数**: 
  - `page` — 页码，默认 1
  - `pageSize` — 每页数量，默认 50，最大 500
  - `keyword` — 搜索关键词（代码、名称或拼音首字母模糊匹配）
  - `symbol` — 股票代码（精确匹配，优先级最高）
  - `market` — 市场代码（精确匹配，如 SH、SZ、BJ）
- **请求头**（可选）:
  - `x-d1-bookmark` — 会话书签，用于继续上一次会话
- **响应头**:
  - `x-d1-bookmark` — 新的会话书签，可在后续请求中使用
- **数据源**: D1数据库（支持全球读复制）

**支持的查询组合**:
- 全量分页（仅 page + pageSize）
- 关键词搜索（keyword，支持拼音首字母）
- 精确代码查询（symbol）
- 按市场筛选（market）
- 组合筛选（如 keyword + market、symbol + market）

**返回字段**:
- `股票代码`: 6位股票代码
- `股票简称`: 股票名称
- `市场代码`: 市场代码（SH/SZ/BJ）

#### 全量分页

**请求示例**:

```
GET /api/cn/stocks?page=1&pageSize=20
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "数据源": "D1数据库",
    "当前页": 1,
    "每页数量": 20,
    "总数量": 5432,
    "总页数": 272,
    "股票列表": [
      {
        "股票代码": "000001",
        "股票简称": "平安银行",
        "市场代码": "SZ"
      },
      {
        "股票代码": "000002",
        "股票简称": "万科A",
        "市场代码": "SZ"
      }
    ],
    "_meta": {
      "served_by_region": "APAC",
      "served_by_primary": false
    }
  }
}
```

#### 关键词搜索

支持按股票代码、名称或拼音首字母搜索。

**请求示例**:

```
GET /api/cn/stocks?keyword=银行
GET /api/cn/stocks?keyword=payh  (拼音首字母搜索)
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "数据源": "D1数据库",
    "当前页": 1,
    "每页数量": 50,
    "总数量": 45,
    "总页数": 1,
    "股票列表": [
      {
        "股票代码": "000001",
        "股票简称": "平安银行",
        "市场代码": "SZ"
      },
      {
        "股票代码": "002142",
        "股票简称": "宁波银行",
        "市场代码": "SZ"
      }
    ],
    "_meta": {
      "served_by_region": "APAC",
      "served_by_primary": false
    }
  }
}
```

#### 按市场筛选

**请求示例**:

```
GET /api/cn/stocks?market=SH&page=1&pageSize=20
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "数据源": "D1数据库",
    "当前页": 1,
    "每页数量": 20,
    "总数量": 2156,
    "总页数": 108,
    "股票列表": [
      {
        "股票代码": "600000",
        "股票简称": "浦发银行",
        "市场代码": "SH"
      },
      {
        "股票代码": "600004",
        "股票简称": "白云机场",
        "市场代码": "SH"
      }
    ],
    "_meta": {
      "served_by_region": "APAC",
      "served_by_primary": false
    }
  }
}
```

#### 精确查询

**请求示例**:

```
GET /api/cn/stocks?symbol=600000
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "数据源": "D1数据库",
    "当前页": 1,
    "每页数量": 50,
    "总数量": 1,
    "总页数": 1,
    "股票列表": [
      {
        "股票代码": "600000",
        "股票简称": "浦发银行",
        "市场代码": "SH"
      }
    ],
    "_meta": {
      "served_by_region": "APAC",
      "served_by_primary": false
    }
  }
}
```

#### 组合筛选

**请求示例**:

```
GET /api/cn/stocks?keyword=银行&page=1&pageSize=10
GET /api/cn/stocks?keyword=科技&market=SZ&pageSize=20
GET /api/cn/stocks?symbol=600000&market=SH
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "数据源": "D1数据库",
    "当前页": 1,
    "每页数量": 10,
    "总数量": 45,
    "总页数": 5,
    "股票列表": [
      {
        "股票代码": "000001",
        "股票简称": "平安银行",
        "市场代码": "SZ"
      }
    ],
    "_meta": {
      "served_by_region": "APAC",
      "served_by_primary": false
    }
  }
}
```

**市场代码说明**:
- `SH` — 上海证券交易所
- `SZ` — 深圳证券交易所
- `BJ` — 北京证券交易所

---

### 2. 股票基本信息

获取股票的市场、板块、总股本、流通股、行业、市值等基础数据。支持批量查询。

- **URL**: `/api/cn/stock/infos?symbols=`
- **参数**: `symbols` — 逗号分隔的股票代码，单次最多 20 只
- **缓存**: 无

**请求示例**:

```
GET /api/cn/stock/infos?symbols=000001,600519
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "来源": "东方财富",
    "更新时间": "2026-02-10 14:00:00",
    "股票数量": 2,
    "股票信息": [
      {
        "市场代码": "SZ",
        "股票代码": "000001",
        "股票简称": "平安银行",
        "总股本": 19405918198,
        "流通股": 19405600653,
        "所属行业": "银行",
        "总市值": 214435396087.9,
        "流通市值": 214431887215.65,
        "上市时间": 19910403,
        "所属板块": "深市主板"
      },
      {
        "市场代码": "SH",
        "股票代码": "600519",
        "股票简称": "贵州茅台",
        "总股本": 1252270215,
        "流通股": 1252270215,
        "所属行业": "酿酒行业",
        "总市值": 1881648702356.85,
        "流通市值": 1881648702356.85,
        "上市时间": 20010827,
        "所属板块": "贵州板块"
      }
    ]
  }
}
```

---

### 3. 实时行情

获取股票行情数据，支持实时行情与历史 K 线查询。提供三级接口，按数据粒度递增：

| 级别 | URL | 说明 |
|------|-----|------|
| 一级 | `/api/cn/stock/quotes/core?symbols=` | 核心行情（最新价、涨跌幅） |
| 二级 | `/api/cn/stock/quotes/activity?symbols=` | 盘口/活跃度（含成交量、换手率、内外盘等） |
| 三级 | `/api/cn/stock/quotes/kline?symbol=` | 历史 K 线（日/周/月/分钟线） |

- **参数**:
  - `core/activity`: `symbols` — 逗号分隔的股票代码，单次最多 20 只
  - `kline`: `symbol` — 单只股票代码（6位数字）
- **缓存**: 无（实时数据）
- **单位说明**: 成交量/内盘/外盘原始单位为手，已统一转换为**股**（1手=100股）；更新时间已从 Unix 时间戳转换为可读格式

#### 3.1 核心行情（一级）

**请求示例**:

```
GET /api/cn/stock/quotes/core?symbols=000001,600519
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "来源": "东方财富",
    "股票数量": 2,
    "行情": [
      {
        "股票代码": "000001",
        "股票简称": "平安银行",
        "最新价": 11.05,
        "涨跌幅": 1.01,
        "更新时间": "2026-02-08 14:35:20"
      },
      {
        "股票代码": "600519",
        "股票简称": "贵州茅台",
        "最新价": 1501.00,
        "涨跌幅": 1.01,
        "更新时间": "2026-02-08 14:35:20"
      }
    ]
  }
}
```

**返回字段**:
- `股票代码`: 6位股票代码
- `股票简称`: 股票名称
- `最新价`: 当前价格
- `涨跌幅`: 涨跌幅百分比
- `更新时间`: 数据更新时间（格式: YYYY-MM-DD HH:mm:ss）

---

#### 3.2 盘口/活跃度（二级）

**请求示例**:

```
GET /api/cn/stock/quotes/activity?symbols=000001
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "来源": "东方财富",
    "股票数量": 1,
    "行情": [
      {
        "股票代码": "000001",
        "股票简称": "平安银行",
        "最新价": 11.05,
        "均价": 11.02,
        "涨跌幅": 1.01,
        "涨跌额": 0.11,
        "成交量": 152380000,
        "成交额": 1679318400,
        "换手率": 0.79,
        "量比": 1.05,
        "最高价": 11.15,
        "最低价": 10.95,
        "今开价": 10.98,
        "昨收价": 10.94,
        "涨停价": 12.03,
        "跌停价": 9.85,
        "外盘": 78560000,
        "内盘": 73820000,
        "更新时间": "2026-02-08 14:35:20"
      }
    ]
  }
}
```

**返回字段**:
- `股票代码`: 6位股票代码
- `股票简称`: 股票名称
- `最新价`: 当前价格
- `均价`: 当日均价
- `涨跌幅`: 涨跌幅百分比
- `涨跌额`: 涨跌金额
- `成交量`: 成交量（股）
- `成交额`: 成交金额（元）
- `换手率`: 换手率百分比
- `量比`: 量比
- `最高价`: 当日最高价
- `最低价`: 当日最低价
- `今开价`: 今日开盘价
- `昨收价`: 昨日收盘价
- `涨停价`: 涨停价
- `跌停价`: 跌停价
- `外盘`: 主动买入成交量（股）
- `内盘`: 主动卖出成交量（股）
- `更新时间`: 数据更新时间

---

#### 3.3 历史 K 线（三级）

获取单只股票历史 K 线数据，支持日线、周线、月线与分钟线。

- **URL**: `/api/cn/stock/quotes/kline`
- **参数**:
  - `symbol` — A 股代码（6位数字，必填）
  - `klt` — K 线周期（可选，默认 `101`）
    - `1`/`5`/`15`/`30`/`60`: 分钟线
    - `101`: 日线
    - `102`: 周线
    - `103`: 月线
  - `fqt` — 复权类型（可选）
    - `0`: 不复权
    - `1`: 前复权
    - `2`: 后复权
    - 默认值：分钟线 `0`，日/周/月线 `1`
  - `limit` — 返回条数（可选，默认 `1000`，最大 `5000`）
  - `startDate` — 开始日期（可选，格式 `YYYYMMDD`，如 `20250101`）
  - `endDate` — 结束日期（可选，格式 `YYYYMMDD`，如 `20251231`）
- **缓存**: 无（实时数据）
- **数据源**: 东方财富

**请求示例**:

```
GET /api/cn/stock/quotes/kline?symbol=600519
GET /api/cn/stock/quotes/kline?symbol=000001&klt=5&limit=120
GET /api/cn/stock/quotes/kline?symbol=300750&klt=101&fqt=2&startDate=20240101&endDate=20241231
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "来源": "东方财富",
    "股票代码": "600519",
    "K线周期": "日线",
    "复权类型": "前复权",
    "数量": 2,
    "K线": [
      {
        "时间": "2026-02-10",
        "开盘价": 1500.12,
        "收盘价": 1512.34,
        "最高价": 1518.88,
        "最低价": 1495.01,
        "成交量": 3567821,
        "成交额": 5389012345.67,
        "振幅": 1.59,
        "涨跌幅": 0.81,
        "涨跌额": 12.22,
        "换手率": 0.28
      },
      {
        "时间": "2026-02-11",
        "开盘价": 1510.00,
        "收盘价": 1508.76,
        "最高价": 1520.00,
        "最低价": 1501.23,
        "成交量": 2987654,
        "成交额": 4512098765.43,
        "振幅": 1.24,
        "涨跌幅": -0.24,
        "涨跌额": -3.58,
        "换手率": 0.24
      }
    ]
  }
}
```

**返回字段**:
- `来源`: 数据来源
- `股票代码`: 查询股票代码
- `K线周期`: 周期中文描述（如 `日线`、`5分钟`）
- `复权类型`: 复权类型中文描述
- `数量`: 本次返回 K 线条数
- `K线`: K 线数据数组
  - `时间`: 交易时间（日线为日期，分钟线为时间戳）
  - `开盘价`: 开盘价
  - `收盘价`: 收盘价
  - `最高价`: 最高价
  - `最低价`: 最低价
  - `成交量`: 成交量
  - `成交额`: 成交额
  - `振幅`: 振幅（%）
  - `涨跌幅`: 涨跌幅（%）
  - `涨跌额`: 涨跌额
  - `换手率`: 换手率（%）

---

### 4. 股票基本面

获取股票估值和基本面数据，包括市盈率、ROE、总市值等财务指标。

- **URL**: `/api/cn/stock/fundamentals?symbols=`
- **参数**: `symbols` — 逗号分隔的股票代码，单次最多 20 只
- **缓存**: 无（实时数据）
- **数据源**: 东方财富

**请求示例**:

```
GET /api/cn/stock/fundamentals?symbols=000001,600519
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "来源": "东方财富",
    "股票数量": 2,
    "行情": [
      {
        "股票代码": "000001",
        "股票简称": "平安银行",
        "季度收益": 0.95,
        "动态市盈率": 5.68,
        "每股净资产": 19.52,
        "市净率": 0.57,
        "总营收": 185692000000,
        "总营收-同比": 8.5,
        "净利润": 45230000000,
        "净利润-同比": 6.2,
        "毛利率": 45.8,
        "净利率": 24.3,
        "ROE": 8.95,
        "负债率": 92.5,
        "总股本": 19405918198,
        "流通股": 19405600653,
        "总市值": 214435396087.9,
        "流通市值": 214431887215.65,
        "每股未分配利润": 12.35,
        "更新时间": "2026-02-08 14:35:20"
      },
      {
        "股票代码": "600519",
        "股票简称": "贵州茅台",
        "季度收益": 45.20,
        "动态市盈率": 33.15,
        "每股净资产": 156.78,
        "市净率": 9.58,
        "总营收": 124560000000,
        "总营收-同比": 12.3,
        "净利润": 56780000000,
        "净利润-同比": 15.6,
        "毛利率": 91.2,
        "净利率": 52.8,
        "ROE": 28.85,
        "负债率": 24.5,
        "总股本": 1256197800,
        "流通股": 1256197800,
        "总市值": 1885616870000,
        "流通市值": 1885616870000,
        "每股未分配利润": 98.45,
        "更新时间": "2026-02-08 14:35:20"
      }
    ]
  }
}
```

**返回字段**:
- `股票代码`: 6位股票代码
- `股票简称`: 股票名称
- `季度收益`: 最近季度每股收益
- `动态市盈率`: 动态市盈率（PE TTM）
- `每股净资产`: 每股净资产
- `市净率`: 市净率（PB）
- `总营收`: 总营收（元）
- `总营收-同比`: 总营收同比增长率（%）
- `净利润`: 净利润（元）
- `净利润-同比`: 净利润同比增长率（%）
- `毛利率`: 毛利率（%）
- `净利率`: 净利率（%）
- `ROE`: 净资产收益率（%）
- `负债率`: 资产负债率（%）
- `总股本`: 总股本（股）
- `流通股`: 流通股本（股）
- `总市值`: 总市值（元）
- `流通市值`: 流通市值（元）
- `每股未分配利润`: 每股未分配利润
- `更新时间`: 数据更新时间

---

### 5. 盈利预测

盈利预测数据存储在 D1 `earnings_forecast` 表。由于一个 `symbol` 可能有多条不同 `update_time` 记录，列表/检索接口均只使用每个 `symbol` 的最新记录。
列表与检索仅返回 `forecast_netprofit_yoy` 非空的数据。

#### 5.1 盈利预测分页列表

- **URL**: `/api/cn/stocks/profit-forecast`
- **查询参数**:
  - `page`（可选）— 页码，默认 `1`
  - `pageSize`（可选）— 每页数量，默认 `50`，最大 `500`
  - `sortBy`（可选）— 排序字段：`symbol` / `forecast_netprofit_yoy`，默认 `forecast_netprofit_yoy`
  - `sortOrder`（可选）— 排序方向：`asc` / `desc`
    - 当 `sortBy=symbol` 时默认 `asc`
    - 当 `sortBy=forecast_netprofit_yoy` 时默认 `desc`

```
GET /api/cn/stocks/profit-forecast?page=1&pageSize=20&sortBy=forecast_netprofit_yoy&sortOrder=desc
```

#### 5.2 盈利预测检索

- **URL**: `/api/cn/stocks/profit-forecast/search`
- **查询参数**:
  - `keyword` 或 `q`（必填）— 关键词（支持股票代码/股票简称/拼音首字母模糊匹配）
  - `page`、`pageSize`、`sortBy`、`sortOrder` 与分页列表一致

```
GET /api/cn/stocks/profit-forecast/search?keyword=平安&page=1&pageSize=10&sortBy=symbol
```

#### 5.3 单只股票盈利预测

获取单只股票的盈利预测详情（摘要 + 详细指标预测），采用“先查 D1，未命中再爬取并写回 D1”的流程。

- **URL**: `/api/cn/stock/:symbol/profit-forecast`
- **查询参数**:
  - `forceRefresh`（可选）— 设为 `1/true` 时跳过 D1，强制重新抓取并写入 D1

```
GET /api/cn/stock/600519/profit-forecast
GET /api/cn/stock/600519/profit-forecast?forceRefresh=1
```

**单票响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "来源": "同花顺 https://basic.10jqka.com.cn/new/600519/worth.html",
    "股票代码": "600519",
    "更新时间": "2026-02-08 10:30:00",
    "净利润同比(%)": 12.36,
    "摘要": "综合机构预测，未来 2 年公司盈利保持增长，估值处于历史中位区间。",
    "业绩预测详表_详细指标预测": [
      {
        "指标": "营业收入",
        "2025E": "1234.56亿",
        "2026E": "1378.90亿",
        "同比": "11.69%"
      }
    ]
  }
}
```

---

### 6. 指数实时行情

获取指数（如沪深 300、上证 50 等）实时行情数据，支持批量查询。

- **URL**: `/api/cn/index/quotes?symbols=`
- **参数**: `symbols` — 逗号分隔的指数代码，单次最多 20 只
- **缓存**: 无（实时数据）
- **数据源**: 东方财富

**请求示例**:

```
GET /api/cn/index/quotes?symbols=000001,399006,399300
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "来源": "东方财富",
    "指数数量": 3,
    "行情": [
      {
        "指数代码": "000001",
        "指数简称": "上证指数",
        "最新价": 3234.56,
        "最高价": 3245.23,
        "最低价": 3215.67,
        "今开价": 3225.00,
        "昨收价": 3210.45,
        "涨跌幅": 0.75,
        "涨跌额": 24.11,
        "成交量": 1523800000,
        "成交额": 16793184000,
        "换手率": 0.45,
        "成交笔数": 8945600,
        "更新时间": "2026-02-09 14:35:20"
      },
      {
        "指数代码": "399006",
        "指数简称": "创业板指",
        "最新价": 1856.34,
        "最高价": 1867.89,
        "最低价": 1840.12,
        "今开价": 1850.00,
        "昨收价": 1842.56,
        "涨跌幅": 0.67,
        "涨跌额": 12.34,
        "成交量": 856700000,
        "成交额": 8456200000,
        "换手率": 0.52,
        "成交笔数": 5234600,
        "更新时间": "2026-02-09 14:35:20"
      }
    ]
  }
}
```

**返回字段**:
- `指数代码`: 指数代码（如 000001 上证指数、399006 创业板指等）
- `指数简称`: 指数名称
- `最新价`: 当前价格（已除以 100）
- `最高价`: 当日最高价（已除以 100）
- `最低价`: 当日最低价（已除以 100）
- `今开价`: 今日开盘价（已除以 100）
- `昨收价`: 昨日收盘价（已除以 100）
- `涨跌幅`: 涨跌幅百分比（已除以 100，单位 %）
- `涨跌额`: 涨跌金额（已除以 100）
- `成交量`: 成交量（股）
- `成交额`: 成交金额（元）
- `换手率`: 换手率百分比（已除以 100，单位 %）
- `成交笔数`: 成交笔数
- `更新时间`: 数据更新时间（格式: YYYY-MM-DD HH:mm:ss）

---

#### 6.1 全球指数实时行情

获取全球指数（如恒生指数、恒生科技、中证等）实时行情数据，支持批量查询。

- **URL**: `/api/gb/index/quotes?symbols=`
- **参数**: `symbols` — 逗号分隔的指数代码（字母数字组合，1-10位），单次最多 20 只
- **缓存**: 无（实时数据）
- **数据源**: 东方财富

**请求示例**:

```
GET /api/gb/index/quotes?symbols=HXC,XIN9,HSTECH
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "来源": "东方财富",
    "指数数量": 3,
    "行情": [
      {
        "指数代码": "HXC",
        "指数简称": "恒生中国企业指数",
        "最新价": 5678.90,
        "最高价": 5698.45,
        "最低价": 5650.23,
        "今开价": 5665.00,
        "昨收价": 5656.78,
        "涨跌幅": 0.39,
        "涨跌额": 22.12,
        "成交量": 856700000,
        "成交额": 4856200000,
        "换手率": 0.35,
        "成交笔数": 234600,
        "更新时间": "2026-02-10 15:35:20"
      },
      {
        "指数代码": "XIN9",
        "指数简称": "富时中国A50",
        "最新价": 13456.78,
        "最高价": 13498.90,
        "最低价": 13420.00,
        "今开价": 13445.00,
        "昨收价": 13434.56,
        "涨跌幅": 0.17,
        "涨跌额": 22.22,
        "成交量": 456700000,
        "成交额": 6156200000,
        "换手率": 0.28,
        "成交笔数": 145600,
        "更新时间": "2026-02-10 15:35:20"
      }
    ]
  }
}
```

**返回字段**: 同 A 股指数行情接口

**注意事项**:
- 指数代码支持字母+数字组合（如 `HXC`, `XIN9`, `HSTECH`），不区分大小写（会自动转换为大写）
- 指数代码长度限制在 1-10 位
- 智能市场ID选择：
  - `HS` 开头的恒生相关指数（如 `HSTECH`, `HSI`）使用市场 ID `124`
  - 其他指数默认使用市场 ID `100`
  - 当默认市场 ID 无数据时，自动降级到市场 ID `251`（用于特殊指数如纳斯达克中国金龙等）

---

### 7. 热门人气榜

获取东方财富个股人气榜（默认 8 条，最多 100 条）。

- **URL**: `/api/cn/market/stockrank`
- **参数**: `count` — 返回数量，默认 8，范围 1-100
- **缓存**: 无（实时数据）

**请求示例**:

```
GET /api/cn/market/stockrank?count=8
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "来源": "东方财富 http://guba.eastmoney.com/rank/",
    "更新时间": "2026-02-08 14:00:00",
    "人气榜": [
      { "当前排名": 1, "股票代码": "000001" },
      { "当前排名": 2, "股票代码": "600519" },
      { "当前排名": 3, "股票代码": "300750" }
    ]
  }
}
```

---

### 8. 新闻头条

获取财联社最新头条新闻（前 5 条）。

- **URL**: `/api/news/headlines`
- **缓存**: 无（实时数据）
- **数据源**: 财联社

**请求示例**:

```
GET /api/news/headlines
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "来源": "财联社",
    "更新时间": "2026-02-09 14:30:00",
    "新闻数量": 5,
    "头条新闻": [
      {
        "ID": 1234567,
        "时间": "2026-02-09 14:25:00",
        "标题": "A股三大指数集体收涨 沪指涨0.75%",
        "摘要": "今日A股三大指数集体收涨，沪指涨0.75%，深成指涨1.23%，创业板指涨1.56%。",
        "作者": "财联社",
        "标签": [],
        "链接": "https://www.cls.cn/detail/1234567"
      },
      {
        "ID": 1234568,
        "时间": "2026-02-09 14:20:00",
        "标题": "央行今日开展500亿元逆回购操作",
        "摘要": "央行公告称，为维护银行体系流动性合理充裕，今日开展500亿元7天期逆回购操作。",
        "作者": "新华社",
        "标签": [],
        "链接": "https://www.cls.cn/detail/1234568"
      }
    ]
  }
}
```

**返回字段**:
- `ID`: 新闻 ID
- `时间`: 新闻发布时间（格式: YYYY-MM-DD HH:mm:ss）
- `标题`: 新闻标题
- `摘要`: 新闻摘要
- `作者`: 新闻来源/作者
- `标签`: 新闻标签数组（预留字段，目前为空）
- `链接`: 新闻详情页链接

---

#### 8.1 新闻分类

获取财联社各类别最新新闻（前 5 条），包括 A 股市场、港股市场、环球、基金/ETF 等分类。

- **缓存**: 无（实时数据）
- **数据源**: 财联社

**可用端点**:

| 端点 | 分类 | 说明 |
|------|------|------|
| `/api/news/cn` | A股市场 | A 股相关新闻 |
| `/api/news/hk` | 港股市场 | 港股相关新闻 |
| `/api/news/gb` | 环球 | 国际财经新闻 |
| `/api/news/fund` | 基金/ETF | 基金和 ETF 相关新闻 |

**请求示例**:

```
GET /api/news/cn
GET /api/news/hk
GET /api/news/gb
GET /api/news/fund
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "来源": "财联社",
    "分类": "A股市场",
    "更新时间": "2026-02-09 14:30:00",
    "新闻数量": 5,
    "头条新闻": [
      {
        "ID": 1234569,
        "时间": "2026-02-09 14:25:00",
        "标题": "A股市场相关新闻标题",
        "摘要": "新闻摘要内容...",
        "作者": "财联社",
        "标签": [],
        "链接": "https://www.cls.cn/detail/1234569"
      }
    ]
  }
}
```

**返回字段**: 同新闻头条接口

---

#### 8.2 个股新闻

按股票代码获取财联社个股相关新闻。

- **URL**: `/api/cn/stocks/:symbol/news`
- **路径参数**:
  - `symbol` — A 股股票代码（6位数字）
- **查询参数**:
  - `limit` — 返回条数，默认 20，范围 1-50
  - `lastTime` — 翻页时间戳（Unix 秒），默认 0
- **缓存**: 无（实时数据）
- **数据源**: 财联社 `csw` 接口

**请求示例**:

```
GET /api/cn/stocks/600519/news
GET /api/cn/stocks/000001/news?limit=10
GET /api/cn/stocks/300750/news?limit=20&lastTime=1739252814
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "来源": "财联社",
    "股票代码": "600519",
    "股票简称": "贵州茅台",
    "查询关键词": "贵州茅台",
    "更新时间": "2026-02-11 15:00:00",
    "lastTime": 0,
    "新闻数量": 2,
    "总数量": 315,
    "个股新闻": [
      {
        "ID": 2285001,
        "链接": "https://www.cls.cn/detail/2285001",
        "标题": "白酒板块走强 贵州茅台涨超2%",
        "时间": "2026-02-11 14:58:21",
        "内容": "白酒板块午后持续走强，贵州茅台涨超2%，五粮液、泸州老窖跟涨。"
      },
      {
        "ID": 2284987,
        "链接": "https://www.cls.cn/detail/2284987",
        "标题": "机构称高端白酒需求韧性仍在",
        "时间": "2026-02-11 13:30:05",
        "内容": "多家机构表示，高端白酒需求仍具韧性，行业库存改善值得关注。"
      }
    ]
  }
}
```

**返回字段**:
- `股票代码`: 路径参数中的 A 股代码
- `股票简称`: 从 D1 `stocks` 表查询到的股票简称（查不到时为空字符串）
- `查询关键词`: 实际用于财联社检索的关键词（优先简称，退化为代码）
- `lastTime`: 本次查询使用的翻页时间戳
- `新闻数量`: 当前返回条数
- `总数量`: 财联社接口返回的总条数（无则回退为当前返回条数）
- `个股新闻`: 新闻数组，包含 `ID`、`链接`、`标题`、`时间`、`内容`

**注意事项**:
- `内容` 字段会移除 HTML 标签，并去掉开头的 `【...】` 前缀。
- `时间` 字段统一格式化为中国时间（`YYYY-MM-DD HH:mm:ss`）。
- 当同时传入 `limit` 和 `lastTime` 时，返回结果会先按 `lastTime` 过滤，再按 `limit` 截断（取交集）。

---

#### 8.3 个股 AI 评价

基于新闻、业绩预测和最近交易数据自动生成个股影响评价，并写入 D1 数据库 `stock_analysis` 表。

- **URL**: `/api/cn/stocks/:symbol/analysis`
- **路径参数**:
  - `symbol` — A 股股票代码（6位数字）
- **查询参数**:
  - `forceRefresh`（可选）— 设为 `1/true` 时强制重新生成评价并写入 D1
- **方法**:
  - `POST` — 触发一次新的 AI 评价，写入 D1 后返回本次结果
  - `GET` — 获取该股票最近一次评价记录；若数据库中无记录会自动触发一次评价并返回
- **模型配置**:
  - 请求地址：`OPENAI_API_BASE_URL`
  - API Key：`OPENAI_API_KEY`
  - 模型名：`EVA_MODEL`

**自动输入数据来源**:
- `news_text`: 财联社个股新闻前 5 条（标题、时间、摘要、链接）
- `forecast_data`: 同花顺盈利预测接口中的 `摘要`
- `trading_data`: 东方财富 `/api/cn/stock/quotes/activity` 同级别数据

**请求示例**:

```bash
POST /api/cn/stocks/600519/analysis
GET  /api/cn/stocks/600519/analysis
GET  /api/cn/stocks/600519/analysis?forceRefresh=1
```

**POST 响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "来源": "AI 股票评价",
    "模型": "gpt-4o-mini",
    "股票代码": "600519",
    "股票简称": "贵州茅台",
    "分析时间": "2026-02-12 16:30:00",
    "结论": "利好",
    "核心逻辑": "......",
    "风险提示": "......",
    "输入摘要": {
      "新闻数量": 5,
      "业绩预测摘要": "机构预测公司盈利稳步提升......",
      "交易数据": {
        "股票代码": "600519",
        "最新价": 1508.76
      }
    }
  }
}
```

**GET 响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "来源": "D1 历史分析",
    "股票代码": "600519",
    "股票简称": "贵州茅台",
    "分析时间": "2026-02-12 16:30:00",
    "结论": "利好",
    "核心逻辑": "......",
    "风险提示": "......"
  }
}
```

---

#### 8.4 自选股图片 OCR

基于 VLM（视觉模型）从截图中批量识别用户自选股列表，返回结构化 JSON。

- **URL**: `/api/cn/stocks/ocr`
- **方法**: `POST`
- **请求头**:
  - `Content-Type: application/json`
- **模型配置**:
  - 请求地址：`OPENAI_API_BASE_URL`
  - API Key：`OPENAI_API_KEY`
  - 模型名：`OCR_MODEL`
- **请求体字段**:
  - `images`（必填）— 图片数组，最多 8 张
  - `hint` / `ocrHint`（可选）— 补充提示（例如“同花顺自选股截图”）
  - `detail`（可选）— 图像细节等级：`low` / `high` / `auto`，默认 `low`
  - `batchConcurrency`（可选）— 批次并发数，范围 1-4，默认 2
  - `maxImagesPerRequest`（可选）— 单次 VLM 请求最多图片数，范围 1-4，默认 4
  - `timeoutMs`（可选）— 模型超时时间（毫秒），范围 10000-120000，默认 45000
- **images 每项支持格式**:
  - `https://...` 或 `http://...` 远程图片 URL
  - `data:image/png;base64,...` Data URL
  - 纯 base64 字符串（服务端自动补齐为 Data URL）
  - 对象格式：`{"url":"https://..."}` 或 `{"data":"<base64>","mime":"image/png"}`

**请求示例**:

```json
{
  "images": [
    "https://example.com/watchlist-1.png",
    "data:image/png;base64,iVBORw0KGgoAAA..."
  ],
  "hint": "同花顺自选股列表",
  "detail": "low",
  "batchConcurrency": 2,
  "maxImagesPerRequest": 2,
  "timeoutMs": 30000
}
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": [
    [
      {
        "股票简称": "贵州茅台",
        "股票代码": "600519"
      },
      {
        "股票简称": "宁德时代",
        "股票代码": "300750"
      }
    ],
    []
  ]
}
```

**返回格式说明**:
- `data` 是“按图片顺序”的二维数组
- 每个元素对应一张图片的识别结果，元素内是股票对象数组
- 与 `{[股票简称：xxxx;股票代码：xxxxx],[],[]}` 的需求等价，标准 JSON 形式为 `[[{"股票简称":"xxxx","股票代码":"xxxxx"}],[],[]]`
- 当识别结果中的 `股票代码` 能命中 D1 `stocks` 表时，`股票简称` 会强制使用数据库标准名称
- 当仅识别到名称（无代码）时，会按名称模糊查询 `stocks`，取首条结果的名称和代码返回

**大图性能建议**:
- 默认 `detail=low`，优先降低推理耗时
- 建议客户端先压缩/缩放图片（例如长边 1400-1800）
- 多图时可调高 `batchConcurrency`（如 2-3）平衡延迟与稳定性
- 如果上游不支持 `image_url.detail`，服务会自动回退到 `auto`

---

### 9. 新闻详情

获取财联社新闻全文内容。

- **URL**: `/api/news/:id`
- **参数**: `id` — 新闻 ID（纯数字）
- **缓存**: 无（实时爬取）
- **数据源**: 财联社

**请求示例**:

```
GET /api/news/2285089
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "ID": "2285089",
    "链接": "https://www.cls.cn/detail/2285089",
    "时间": "2026-02-09 14:25:00",
    "标题": "力挺"特朗普关税"？美联储理事米兰：美国民众并未受到冲击！",
    "摘要": "今日A股三大指数集体收涨，沪指涨0.75%，深成指涨1.23%，创业板指涨1.56%。",
    "标签": [],
    "正文": "<div class=\"m-b-10\"><p><strong>财联社2月9日讯（编辑 刘蕊）</strong>根据Counterpoint本月发布的《内存价格追踪》报告显示，2026年第一季度，全球内存价格环比飙升了80%至90%，创下前所未有的涨幅纪录。</p>\n<p>此次价格上涨的主要原因是通用服务器DRAM价格大幅上涨。此外，在第四季度价格表现相对平静的NAND芯片，在今年第一季度也出现了80%至90%的同步上涨。</p>\n<p><img src=\"https://image.cls.cn/images/20260209/KNomoXk6KH_930x426.png\" alt=\"image\"></p>\n<h3>PC和服务器内存价格趋势(2025年第二季度至2026年第二季度预测)</h3>\n<p>以服务器级内存为例，64GB RDIMM的价格从去年第四季度固定合同价450美元飙升至第一季度的900多美元，预计第二季度将突破1000美元大关。</p>\n<blockquote>\n<p>\"内存芯片盈利能力预计将达到前所未有的水平。尤其是DRAM的营业利润率在2025年第四季度已达到60%左右，这是通用DRAM的利润率首次超过HBM芯片。\"</p>\n</blockquote></div>"
  }
}
```

**返回字段**:
- `ID`: 新闻 ID
- `链接`: 新闻详情页 URL
- `时间`: 新闻发布时间（格式: YYYY-MM-DD HH:mm:ss）
- `标题`: 新闻标题
- `摘要`: 新闻摘要（已去除【】符号）
- `标签`: 新闻标签数组（预留字段，目前为空）
- `正文`: 新闻正文HTML内容（保留完整HTML格式，包含 `<p>`、`<strong>`、`<img>`、`<h3>`、`<blockquote>` 等标签）

**正文HTML支持的样式**:
- `<p>`: 段落
- `<strong>`: 加粗文本
- `<img>`: 图片（包含 src 和 alt 属性）
- `<h3>`: 三级标题
- `<blockquote>`: 引用块
- 等其他HTML标签

**注意事项**:
- 本接口支持两种新闻详情页格式：标准详情页和电报快讯页
- 电报快讯页的图片会自动提取并追加到正文末尾

---

### 10. 微信网页授权登录

基于微信 OAuth2.0 的网页授权登录，用户授权后自动在 D1 数据库创建/更新用户记录，签发 JWT 写入 Cookie。

#### 10.1 跳转微信授权

- **URL**: `GET /api/auth/wechat/login`
- **参数**:
  - `redirect`（可选）— 登录成功后跳转的路径，默认 `/`
- **行为**: 302 跳转至微信授权页面

**请求示例**:

```
GET /api/auth/wechat/login
GET /api/auth/wechat/login?redirect=/dashboard
```

#### 10.2 微信回调

- **URL**: `GET /api/auth/wechat/callback`
- **参数**: 由微信自动附带 `code` 和 `state`
- **行为**:
  1. 用 `code` 向微信换取 `access_token` + `openid`
  2. 用 `access_token` 拉取用户昵称、头像
  3. UPSERT 至 D1 `users` 表
  4. 签发 JWT（有效期 7 天）
  5. `Set-Cookie: token=<jwt>; HttpOnly; Secure; SameSite=Lax`
  6. 302 跳回前端首页或 `state` 指定的地址

#### 10.3 获取当前登录用户

- **URL**: `GET /api/users/me`
- **请求方式**: 带上浏览器 Cookie（`credentials: include`）
- **返回**: 用户信息 + 自选股列表

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "openid": "oXXX",
    "nickname": "张三",
    "avatar_url": "https://...",
    "created_at": "2026-02-10 14:00:00",
    "自选股": [
      { "股票代码": "600519", "股票简称": "贵州茅台", "市场代码": "SH", "添加时间": "2026-02-10 14:00:00" },
      { "股票代码": "000001", "股票简称": "平安银行", "市场代码": "SZ", "添加时间": "2026-02-10 14:00:00" }
    ]
  }
}
```

#### 10.4 退出登录

- **URL**: `GET /api/auth/logout`
- **行为**: 清除 `token` Cookie（`Max-Age=0`，带 `Domain`/`Path=/`），返回 `{ code:200, message:'success' }`

---

#### 10.5 自选股管理（用户态）

- **添加自选（批量）**: `POST /api/users/me/favorites`
  - Body: `{ "symbols": ["000001", "600519"] }` 或查询参数 `?symbols=000001,600519`
- **删除自选（批量）**: `DELETE /api/users/me/favorites`
  - Body: `{ "symbols": ["000001", "600519"] }`
  - 兼容: `POST /api/users/me/favorites/delete`（部分客户端不便发送 DELETE，可用 Body 或查询参数）
- **认证**: Cookie 中的 `token`（需携带凭证访问）
- **返回**: 最新用户信息 + `自选股` 列表

**响应示例（添加/删除后返回相同结构）**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "openid": "oXXX",
    "nickname": "张三",
    "avatar_url": "https://...",
    "created_at": "2026-02-10 14:00:00",
    "自选股": [
      { "股票代码": "600519", "股票简称": "贵州茅台", "市场代码": "SH", "添加时间": "2026-02-10 14:00:00" },
      { "股票代码": "000001", "股票简称": "平安银行", "市场代码": "SZ", "添加时间": "2026-02-10 14:00:00" }
    ]
  }
}
```

---

#### 10.6 用户推送新闻（占位）

- **URL**: `GET /api/users/me/news/push`
- **认证**: Cookie 中的 `token`（需携带凭证访问）
- **说明**: 当前为占位接口，默认返回空列表

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "推送新闻": []
  }
}
```

---

#### 10.7 用户设置（用户态）

- **URL**: `GET /api/users/me/settings`
- **认证**: Cookie 中的 `token`（需携带凭证访问）
- **说明**: 返回当前登录用户在 `user_settings` 表中的配置；无配置时返回空数组
- **更新设置类型**: `PUT /api/users/me/settings/:settingType`
  - Body: `{ "enabled": true }`（也支持 `0/1`）
  - 行为: 按 `(openid, setting_type)` UPSERT 更新

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "openid": "oXXX",
    "settings": [
      {
        "setting_type": "daily_news_push",
        "enabled": true,
        "updated_at": "2026-02-12 10:00:00"
      }
    ]
  }
}
```

**更新响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "openid": "oXXX",
    "setting_type": "daily_news_push",
    "enabled": true,
    "updated_at": "2026-02-12 11:00:00"
  }
}
```

---

#### 10.8 消息与事件推送（服务端回调）

- **URL**: `GET/POST /api/auth/wechat/push`
- **用途**:
  - GET: 微信服务器配置校验（原样返回 `echostr`）
  - POST: 接收微信消息/事件推送，已支持 `subscribe`（首次关注）和 `SCAN`（已关注扫码）事件，自动识别带参二维码触发扫码登录。
- **签名验证**: 使用 `WECHAT_TOKEN` + `timestamp` + `nonce` 字典序拼接取 SHA1，与 `signature` 比较，失败返回 401。
- **配置指引**: 微信开放平台「消息与事件推送」配置该地址，Token 填 `WECHAT_TOKEN`。

---

#### 10.9 扫码登录

通过微信公众号带参二维码实现 PC 端扫码登录，无需微信开放平台。

**流程说明**:

```
前端                          后端                          微信
 │                             │                             │
 │  GET /login/scan            │                             │
 │ ─────────────────────────►  │  生成 state                 │
 │                             │  获取 server access_token    │
 │                             │  ─────────────────────────►  │
 │                             │  创建临时带参二维码          │
 │                             │  ◄─────────────────────────  │
 │  { state, qr_url }         │  存 KV: pending              │
 │ ◄─────────────────────────  │                             │
 │                             │                             │
 │  展示二维码给用户           │                             │
 │                             │                             │
 │                             │     用户扫码 / 关注          │
 │                             │  ◄─────────────────────────  │
 │                             │  subscribe/SCAN 事件         │
 │                             │  提取 EventKey → state       │
 │                             │  UPSERT 用户 + 签发 JWT      │
 │                             │  更新 KV: confirmed + jwt    │
 │                             │                             │
 │  GET /login/scan/poll       │                             │
 │ ─────────────────────────►  │                             │
 │  { status: confirmed }      │                             │
 │  Set-Cookie: token=jwt      │                             │
 │ ◄─────────────────────────  │                             │
```

##### 10.9.1 生成扫码二维码

- **URL**: `GET /api/auth/wechat/login/scan`
- **返回**: `state`（登录跟踪 ID）、`qr_url`（二维码图片地址）、`expire_seconds`（有效期 300 秒）

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "state": "a1b2c3d4e5f6...",
    "qr_url": "https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=...",
    "expire_seconds": 300
  }
}
```

##### 10.9.2 轮询登录状态

- **URL**: `GET /api/auth/wechat/login/scan/poll?state=<state>`
- **参数**: `state` — 生成二维码时返回的跟踪 ID
- **返回状态**:

| status | 说明 | HTTP 行为 |
|--------|------|-----------|
| `pending` | 等待用户扫码 | 200，前端继续轮询 |
| `confirmed` | 登录成功 | 200 + `Set-Cookie: token=<jwt>`，前端停止轮询 |
| 404 | 二维码已过期或 state 无效 | 前端提示重新生成 |

**响应示例（等待中）**:

```json
{
  "code": 200,
  "message": "pending",
  "data": { "status": "pending" }
}
```

**响应示例（登录成功）**:

```json
{
  "code": 200,
  "message": "confirmed",
  "data": { "status": "confirmed", "openid": "oXXX" }
}
```

**前端轮询建议**: 每 2 秒请求一次，最多轮询 150 次（5 分钟），超时后提示用户刷新二维码。

---

**环境变量**:

| 变量名 | 说明 |
|--------|------|
| `WECHAT_APPID` | 微信服务号 AppID |
| `WECHAT_SECRET` | 微信服务号 AppSecret |
| `JWT_SECRET` | JWT 签名密钥 |
| `WECHAT_TOKEN` | 微信消息推送校验 Token（与微信后台配置一致） |
| `FRONTEND_URL` | 前端首页地址（登录成功后默认跳转），例如 `https://aistocklink.cn` |
| `COOKIE_DOMAIN` | Cookie 作用域，前后端跨子域时填父域，例如 `aistocklink.cn` |
| `CORS_ALLOW_ORIGIN` | 允许的前端来源，例如 `https://aistocklink.cn` |
| `OPENAI_API_BASE_URL` | 大模型接口地址（OpenAI 兼容 Chat Completions） |
| `OPENAI_API_KEY` | 大模型接口密钥 |
| `EVA_MODEL` | 个股评价使用的模型名 |
| `OCR_MODEL` | 自选股图片 OCR 使用的模型名 |

设置方式：

```bash
wrangler secret put WECHAT_APPID
wrangler secret put WECHAT_SECRET
wrangler secret put JWT_SECRET
wrangler secret put FRONTEND_URL
wrangler secret put OPENAI_API_KEY
# 可选，若不想放 secret：在 wrangler.toml 的 [vars] 写入 COOKIE_DOMAIN / CORS_ALLOW_ORIGIN
```

---

## 错误响应

| code | 说明 |
|------|------|
| 400 | 参数错误（缺少 symbol 或格式不合法） |
| 404 | 接口不存在 |
| 405 | 请求方法不允许（接口未实现该 HTTP 方法） |
| 500 | 服务端错误 |

**示例**:

```json
{
  "code": 400,
  "message": "Invalid symbol - A股代码必须是6位数字",
  "data": null
}
```

---

## 更新日志

### 2026年2月17日
- **新增功能**:
  - 新增自选股图片 OCR 接口 `POST /api/cn/stocks/ocr`，支持批量图片识别股票简称和股票代码。
  - 新增 `StockOcrService` 与 `StockOcrController`，包含 VLM 请求、提示词约束、JSON 解析与容错清洗。
  - 模型配置新增 `OCR_MODEL`，复用 `OPENAI_API_BASE_URL` + `OPENAI_API_KEY`。
- **性能优化**:
  - 增加图像细节参数 `detail`（默认 `low`）以降低大图识别耗时。
  - 支持批次并发 `batchConcurrency`（默认 2）并保持返回顺序稳定。
  - 接口兼容回退机制：当上游不支持 `image_url.detail` 时自动回退 `auto`。

### 2026年2月12日
- **新增功能**:
  - 新增 RESTful 个股 AI 评价接口 `/api/cn/stocks/:symbol/analysis`：
    - `POST` 触发实时分析（自动聚合新闻/预测/交易数据 → 调用大模型 → 写入 D1）
    - `GET` 查询该股票最新一条分析记录
  - 新增 `StockAnalysisService`，支持：
    - 自动请求 `OPENAI_API_BASE_URL`，使用 `OPENAI_API_KEY` 鉴权
    - 使用 `EVA_MODEL` 进行结构化评价输出
    - 对模型返回 JSON 结构和字段约束做校验，不合规自动重试一次
  - 新增 `stock_analysis` 表读写支持，保存字段：`结论`、`核心逻辑`、`风险提示`。

### 2026年2月11日
- **新增功能**:
  - 新增 RESTful 个股新闻接口 `GET /api/cn/stocks/:symbol/news`，用于按股票代码获取财联社相关新闻。
  - 接口支持 `limit`（1-50）和 `lastTime`（翻页时间戳）参数。
  - 个股新闻查询关键词优先使用 D1 `stocks` 表中的股票简称，未命中时自动回退为股票代码。
- **数据处理**:
  - 新增财联社个股新闻响应抽取与标准化：
    - 兼容多层 `data` 包裹结构，提取 `list` 和 `total`
    - 清洗新闻内容 HTML 标签并去除 `【...】` 前缀
    - 时间戳统一转换为中国时间格式

### 2026年2月10日
- **新增功能**:
  - 新增微信网页授权登录接口：
    - `GET /api/auth/wechat/login` — 302 跳转微信授权页
    - `GET /api/auth/wechat/callback?code=xxx` — 回调处理：code 换 token → 拉取用户信息 → D1 入库 → 签发 JWT → Set-Cookie → 302 跳回首页
    - 使用 Web Crypto API 实现 HMAC-SHA256 JWT 签发/验证，无外部依赖
    - 用户表支持 UPSERT（首次登录自动创建，再次登录更新昵称/头像）
  - 新增 A 股列表查询接口，基于 Cloudflare D1 数据库：
    - `/api/cn/stocks` - 支持全量分页、关键词搜索、精确查询和组合筛选
    - **使用 D1 Sessions API 实现全球读复制**，通过将查询路由到离用户更近的只读副本来降低延迟
    - 响应包含 `_meta` 字段，显示查询被哪个区域的副本处理（`served_by_region`）
    - 支持通过 `x-d1-bookmark` 请求头/响应头维持会话连续性
    - **支持按市场筛选**（`market` 参数，如 SH、SZ、BJ）
    - **关键词搜索支持拼音首字母**（存储 pinyin 字段，查询时匹配但不返回）
    - 返回字段包含 `股票代码`、`股票简称`、`市场代码`
  - 新增 Cloudflare D1 数据库支持，存储 5000+ A 股股票的代码和名称数据
  - 新增股票基本信息批量查询接口 `/api/cn/stock/infos?symbols=`，支持单次查询最多 20 只股票
  - 移除人气榜缓存机制，改为实时查询，新增 `count` 参数支持自定义返回数量（默认8条，最多100条）
  - 修复新闻详情时间解析问题，网页中国时间不再错误转换为 UTC+16
  - 新增全球指数实时行情接口 `/api/gb/index/quotes?symbols=`，支持批量查询全球指数（如恒生指数、恒生科技、中证等），代码支持字母数字组合，最多 20 只指数。
  - 新增股票基本面独立接口 `/api/cn/stock/fundamentals?symbols=`，从行情接口中独立出来，更符合语义。
  - 新增限流机制，按数据源分组独立限流，避免触发反爬机制：
    - **同花顺限流器**: 用于 `ThsService`，默认 300ms 间隔
    - **东方财富限流器**: 用于 `EmInfoService`、`EmQuoteService`、`EmStockRankService`、`IndexQuoteController`，所有东财接口共享同一限流器，默认 300ms 间隔
    - **财联社限流器**: 用于 `NewsController`，默认 300ms 间隔
  - 全球指数智能市场ID选择：`HS` 开头的恒生指数使用市场 ID `124`，其他指数默认 `100`，失败时自动降级到 `251`。
- **重构优化**:
  - **API路由重构**: 
    - 将 `/api/cn/stock/quotes/fundamental` 重构为 `/api/cn/stock/fundamentals`，基本面数据不应归属于行情（quotes）类别
    - 移除单个股票信息查询接口 `/api/cn/stock/info/:symbol`，统一使用批量接口 `/api/cn/stock/infos?symbols=`
  - 字段名称规范化：`市场` → `市场代码`，`行业` → `所属行业`，`板块` → `所属板块`
  - 在 `validator.ts` 中新增 `isValidGlobalIndexSymbol` 验证器，支持字母数字组合的指数代码（1-10位）。
  - 在 `IndexQuoteController` 中新增 `getGlobalIndexQuotes` 方法，使用智能市场 ID 选择和降级机制查询全球指数。
  - 创建 `utils/throttle.ts` 限流基础工具，提供全局限流函数和独立限流器工厂。
  - 创建 `utils/throttlers.ts` 限流器实例文件，按数据源创建独立的限流器，确保不同数据源之间不会相互干扰。
  - 在所有服务层和控制器中应用对应的限流器，确保请求频率控制的同时不影响跨数据源的并发性能。

### 2026年2月9日
- **新增功能**:
  - 新增指数实时行情接口 `/api/cn/index/quotes?symbols=`，支持批量查询，最多 50 只指数。
  - 新增新闻头条接口 `/api/news/headlines`，返回财联社最新头条新闻（前 5 条）。
  - 新增新闻分类接口，支持 A 股市场 (`/api/news/cn`)、港股市场 (`/api/news/hk`)、环球 (`/api/news/gb`)、基金/ETF (`/api/news/fund`) 四个分类。
  - 新增新闻详情接口 `/api/news/:id`，爬取财联社新闻全文（含摘要和正文）。
- **性能优化**:
  - 移除 `ThsService` 中的 `extractSection` 方法，减少字符串扫描的 CPU 开销。
  - HTML 预处理阶段剥离 `<script>`、`<style>`、注释等内容，缩减 cheerio 解析的 DOM 树规模。
  - 使用精确的 CSS 选择器替代多次 `cheerio.load`，显著提升 HTML 解析效率。
  - 移除 `parser.ts` 中的冗余表格验证逻辑，减少不必要的文本遍历。
  - 优化了盈利预测接口的解析逻辑，减少 Worker 超时失败的可能性。
  - 新闻详情爬取优化：预先剥离 script/style 标签，使用属性选择器快速定位内容。

---

## 数据库配置

本项目使用 Cloudflare D1 数据库存储股票基础数据和分析结果。

### 初始化 D1 数据库

1. **创建数据库**:
```bash
wrangler d1 create aistock
```

2. **更新配置**: 将返回的 `database_id` 填入 `wrangler.toml` 的 D1 配置中

3. **初始化数据**: 
```bash
wrangler d1 execute aistock --file=./scripts/stocks.sql
wrangler d1 execute aistock --file=./scripts/earnings_forecast.sql
wrangler d1 execute aistock --file=./scripts/stock_analysis.sql
```

或使用提供的脚本一键初始化：
```bash
./scripts/init-d1.sh
```

4. **启用读复制（可选但推荐）**:
```bash
# 在 Cloudflare Dashboard 中启用，或使用 REST API
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"read_replication": {"mode": "auto"}}'
```

5. **创建索引以提升查询性能（推荐）**:

使用一键脚本创建索引：
```bash
chmod +x scripts/create-indexes.sh
./scripts/create-indexes.sh
```

或手动创建 market 索引：
```bash
wrangler d1 execute aistock --command="CREATE INDEX IF NOT EXISTS idx_stocks_market ON stocks(market);"
```

**性能提升**：
- 按市场筛选查询性能提升 **10-100倍**
- 组合查询（market + keyword/symbol）显著加速

**读复制的优势**：
- 降低全球用户的查询延迟（通过就近的只读副本）
- 提高读取吞吐量（多个副本并行处理）
- 无额外费用（按实际读写行数计费）

详细说明请参考：
- [D1 数据库设置指南](docs/D1_SETUP.md)
- [D1 读复制使用示例](docs/D1_READ_REPLICATION_USAGE.md)
- [D1 性能优化指南](docs/D1_PERFORMANCE_OPTIMIZATION.md) - **查询性能优化必读**

---

## 开发

```bash
# 安装依赖
npm install

# 本地开发
npx wrangler dev

# 类型检查
npx tsc --noEmit

# 部署
npm run deploy
```
