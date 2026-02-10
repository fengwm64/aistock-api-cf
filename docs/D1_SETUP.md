# D1 数据库设置指南

本项目使用 Cloudflare D1 数据库存储股票基础数据。

## 1. 创建 D1 数据库

```bash
wrangler d1 create aistock
```

执行后会返回 database_id，需要将其填入 `wrangler.toml` 中的 `database_id` 字段。

输出示例：
```
✅ Successfully created DB 'aistock'

[[d1_databases]]
binding = "DB"
database_name = "aistock"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

## 2. 更新 wrangler.toml

将上述输出中的 `database_id` 填入 `wrangler.toml` 的 D1 配置中：

```toml
[[d1_databases]]
binding = "DB"
database_name = "aistock"
database_id = "你的database_id"  # 填入步骤1中获得的ID
```

## 3. 初始化数据库

执行 SQL 文件初始化表结构和数据：

```bash
wrangler d1 execute aistock --file=./scripts/stocks.sql
```

## 4. 验证数据

查询股票数量：

```bash
wrangler d1 execute aistock --command="SELECT COUNT(*) as count FROM stocks"
```

查询示例数据：

```bash
wrangler d1 execute aistock --command="SELECT * FROM stocks LIMIT 10"
```

## 5. 创建索引（强烈推荐）

为常用查询字段创建索引可以显著提升查询性能。

### 5.1 创建 market 索引

```bash
wrangler d1 execute aistock --command="CREATE INDEX IF NOT EXISTS idx_stocks_market ON stocks(market);"
```

**性能提升**：按市场筛选查询（`WHERE market = 'SH'`）将从全表扫描优化为索引查找，性能提升 **10-100倍**。

### 5.2 验证索引

查看已创建的索引：

```bash
wrangler d1 execute aistock --command="SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='stocks';"
```

输出示例：
```
┌───────────────────────┬──────────────────────────────────────────────────────┐
│ name                  │ sql                                                  │
├───────────────────────┼──────────────────────────────────────────────────────┤
│ idx_stocks_market     │ CREATE INDEX idx_stocks_market ON stocks(market)     │
└───────────────────────┴──────────────────────────────────────────────────────┘
```

### 5.3 更多优化

查看完整的性能优化指南：[D1 性能优化指南](D1_PERFORMANCE_OPTIMIZATION.md)

## 6. 本地开发

本地开发时使用：

```bash
# 本地启动 worker
wrangler dev

# 本地执行 SQL（用于本地测试）
wrangler d1 execute aistock --local --file=./scripts/stocks.sql
```

## 7. 常用 D1 命令

```bash
# 列出所有数据库
wrangler d1 list

# 执行单条 SQL
wrangler d1 execute aistock --command="SELECT * FROM stocks WHERE symbol='000001'"

# 删除数据库（谨慎使用）
wrangler d1 delete aistock

# 查看数据库信息
wrangler d1 info aistock
```

## 8. 启用读复制（Read Replication）

D1 读复制可以通过在全球多个区域创建只读副本来降低查询延迟并提高读取吞吐量。

### 8.1 通过 Dashboard 启用

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 **D1** 页面
3. 选择 `aistock` 数据库
4. 点击 **Settings**
5. 启用 **Enable Read Replication**

### 8.2 通过 REST API 启用

需要先创建具有 `D1:Edit` 权限的 API Token。

```bash
# 设置你的 API Token
export CF_API_TOKEN="your_api_token_here"
export CF_ACCOUNT_ID="your_account_id_here"
export CF_DATABASE_ID="087b72de-672c-4d40-9fc8-f90b2146abfc"

# 启用读复制
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_DATABASE_ID}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"read_replication": {"mode": "auto"}}'
```

### 7.3 验证读复制状态

```bash
# 查询数据库配置
curl -X GET "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_DATABASE_ID}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}"
```

查看响应中的 `read_replication.mode` 字段：
- `"mode": "auto"` 表示已启用
- `"mode": "disabled"` 表示未启用

### 7.4 读复制的优势

- **降低延迟**：查询会路由到离用户更近的只读副本
- **提高吞吐量**：多个副本可以并行处理读请求
- **全球分布**：副本覆盖 ENAM、WNAM、WEUR、EEUR、APAC、OC 等区域
- **顺序一致性**：通过 Sessions API 保证数据一致性

### 7.5 无额外费用

D1 读复制无需额外付费，按实际读写行数计费，与不使用读复制时相同。

### 7.6 Sessions API

本项目的 A 股列表查询接口已使用 D1 Sessions API，自动支持读复制：

- 请求通过 `x-d1-bookmark` 头传递会话上下文
- 响应返回新的 `x-d1-bookmark` 用于后续请求
- 保证顺序一致性（Sequential Consistency）

详细文档：[Cloudflare D1 Read Replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)

## 表结构

### stocks 表

| 字段   | 类型 | 说明     |
|--------|------|----------|
| symbol | TEXT | 股票代码（主键）|
| name   | TEXT | 股票名称 |

示例数据：
```sql
INSERT INTO stocks (symbol, name) VALUES
('000001','平安银行'),
('600519','贵州茅台');
```
