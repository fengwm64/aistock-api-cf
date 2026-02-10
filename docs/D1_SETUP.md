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

## 5. 本地开发

本地开发时使用：

```bash
# 本地启动 worker
wrangler dev

# 本地执行 SQL（用于本地测试）
wrangler d1 execute aistock --local --file=./scripts/stocks.sql
```

## 6. 常用 D1 命令

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
