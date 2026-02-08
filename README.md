# AIStock API

A 股数据 API，基于 Cloudflare Workers 构建，提供股票基本信息、实时行情、盈利预测、热门人气榜等接口。

## 架构

```
src/
├── index.ts                        # 入口 & 路由分发
├── controllers/                    # 控制器层：参数校验、缓存逻辑、响应组装
│   ├── StockInfoController.ts      # 股票基本信息
│   ├── StockQuoteController.ts     # 实时行情
│   ├── StockRankController.ts      # 热门人气榜
│   └── ProfitForecastController.ts # 盈利预测
├── services/                       # 服务层：核心业务逻辑 & 外部数据源请求
│   ├── EmService.ts                # 东方财富 - 股票基本信息
│   ├── EmQuoteService.ts           # 东方财富 - 实时行情
│   ├── EmStockRankService.ts       # 东方财富 - 人气榜排名
│   ├── ThsService.ts               # 同花顺 - 盈利预测
│   └── CacheService.ts             # KV 缓存封装
└── utils/                          # 工具层
    ├── response.ts                 # 统一响应格式
    ├── validator.ts                # A 股代码校验
    ├── stock.ts                    # 股票市场/板块识别
    ├── datetime.ts                 # 日期时间格式化
    └── parser.ts                   # HTML 表格解析
```

### 分层设计

| 层级 | 职责 | 示例 |
|------|------|------|
| **路由层** (`index.ts`) | URL 匹配、参数提取、方法校验 | `GET /api/cn/stock/info/000001` |
| **控制器层** (`controllers/`) | 参数校验、缓存读写、响应组装 | 缓存命中返回 `success (cached)` |
| **服务层** (`services/`) | 外部 API 调用、数据转换 | 请求东方财富/同花顺接口 |
| **工具层** (`utils/`) | 通用函数，无业务逻辑 | 日期格式化、代码校验 |

### 技术栈

- **Runtime**: Cloudflare Workers
- **Language**: TypeScript
- **Cache**: Cloudflare Workers KV
- **HTML Parsing**: cheerio
- **Encoding**: TextDecoder (GBK)

---

## API 接口

所有接口仅支持 `GET` 请求，统一响应格式：

```json
{
  "code": 200,
  "message": "success",
  "data": { ... }
}
```

### 1. 股票基本信息

获取股票的市场、板块、总股本、流通股、行业、市值等基础数据。

- **URL**: `/api/cn/stock/info/:symbol`
- **缓存**: 14 天

**请求示例**:

```
GET /api/cn/stock/info/000001
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "updateTime": "2026-02-08 12:08:16",
    "市场": "sz",
    "板块": "深市主板",
    "股票代码": "000001",
    "股票简称": "平安银行",
    "总股本": 19405918198,
    "流通股": 19405600653,
    "行业": "银行",
    "总市值": 214435396087.9,
    "流通市值": 214431887215.65,
    "上市时间": 19910403
  }
}
```

---

### 2. 实时行情

获取股票最新价、涨跌额、涨跌幅。

- **URL**: `/api/cn/stock/quote/:symbol`
- **缓存**: 无（实时数据）

**请求示例**:

```
GET /api/cn/stock/quote/000001
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "updateTime": "2026-02-08 14:35:20",
    "股票代码": "000001",
    "股票简称": "平安银行",
    "最新价": 11.05,
    "涨跌额": 0.11,
    "涨跌幅": 1.01
  }
}
```

---

### 3. 盈利预测

获取机构对股票的盈利预测数据，包括每股收益、净利润预测及机构详表。

- **URL**: `/api/cn/stock/profit-forecast/:symbol`
- **缓存**: 7 天

**请求示例**:

```
GET /api/cn/stock/profit-forecast/600519
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "股票代码": "600519",
    "updateTime": "2026-02-08 10:30:00",
    "预测年报每股收益": [
      { "年度": "2025", "预测平均值": "66.82", "预测最高值": "70.50", "预测最低值": "63.00" }
    ],
    "预测年报净利润": [
      { "年度": "2025", "预测平均值": "840.00亿", "预测最高值": "886.00亿", "预测最低值": "792.00亿" }
    ],
    "业绩预测详表_机构": [
      {
        "机构名称": "中信证券",
        "研究员": "张三",
        "预测年报每股收益": { "2024": "62.50", "2025": "68.00", "2026": "75.00" },
        "预测年报净利润": { "2024": "786亿", "2025": "855亿", "2026": "943亿" },
        "报告日期": "2026-01-15"
      }
    ]
  }
}
```

---

### 4. 热门人气榜

获取东方财富个股人气榜 Top 100。

- **URL**: `/api/cn/market/stockrank/`
- **缓存**: 10 分钟

**请求示例**:

```
GET /api/cn/market/stockrank/
```

**响应示例**:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "updateTime": "2026-02-08 14:00:00",
    "人气榜": [
      { "当前排名": 1, "股票代码": "000001" },
      { "当前排名": 2, "股票代码": "600519" },
      { "当前排名": 3, "股票代码": "300750" }
    ]
  }
}
```

---

## 错误响应

| code | 说明 |
|------|------|
| 400 | 参数错误（缺少 symbol 或格式不合法） |
| 404 | 接口不存在 |
| 405 | 请求方法不允许（仅支持 GET） |
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
