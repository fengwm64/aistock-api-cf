# D1 数据库性能优化指南

## 当前表结构

```sql
CREATE TABLE IF NOT EXISTS stocks (
    symbol TEXT PRIMARY KEY,
    name   TEXT NOT NULL,
    pinyin TEXT NOT NULL,
    market TEXT NOT NULL
);
```

## 性能优化建议

### 1. 创建索引

为常用的查询字段创建索引可以显著提升查询性能。

#### 1.1 为 market 列创建索引

由于经常需要按市场筛选股票，建议为 `market` 列创建索引：

```sql
CREATE INDEX IF NOT EXISTS idx_stocks_market ON stocks(market);
```

执行命令：
```bash
wrangler d1 execute aistock --command="CREATE INDEX IF NOT EXISTS idx_stocks_market ON stocks(market);"
```

**性能提升**：
- 查询 `WHERE market = 'SH'` 时，从全表扫描（O(n)）优化为索引查找（O(log n)）
- 组合查询 `WHERE market = 'SH' AND symbol LIKE '%xxx%'` 时，先通过索引过滤市场，再进行 LIKE 匹配

#### 1.2 为 pinyin 列创建索引（可选）

如果拼音搜索频繁且数据量大，可以考虑创建索引：

```sql
CREATE INDEX IF NOT EXISTS idx_stocks_pinyin ON stocks(pinyin);
```

执行命令：
```bash
wrangler d1 execute aistock --command="CREATE INDEX IF NOT EXISTS idx_stocks_pinyin ON stocks(pinyin);"
```

**注意**：
- `LIKE '%keyword%'`（前后通配符）无法使用索引
- `LIKE 'keyword%'`（前缀匹配）可以使用索引
- 如果大部分搜索都是前后通配符，该索引可能帮助有限

#### 1.3 组合索引（高级优化）

如果经常组合查询 `WHERE market = ? AND symbol LIKE ?`，可以创建组合索引：

```sql
CREATE INDEX IF NOT EXISTS idx_stocks_market_symbol ON stocks(market, symbol);
```

执行命令：
```bash
wrangler d1 execute aistock --command="CREATE INDEX IF NOT EXISTS idx_stocks_market_symbol ON stocks(market, symbol);"
```

**性能提升**：
- 组合查询时，先通过 market 过滤，再在结果集中查找 symbol
- 适合 `WHERE market = 'SH' AND symbol = '600000'` 这种精确查询

### 2. 查询性能分析

#### 2.1 各查询场景的性能特征

| 查询类型 | WHERE 条件 | 索引使用情况 | 性能 |
|---------|-----------|-------------|------|
| 全量分页 | 无 | 仅 ORDER BY 使用主键索引 | ⭐⭐⭐⭐ 良好 |
| 精确代码查询 | `symbol = ?` | 主键索引 | ⭐⭐⭐⭐⭐ 优秀 |
| 市场筛选 | `market = ?` | market 索引（需创建） | ⭐⭐⭐⭐ 良好 |
| 关键词搜索 | `symbol/name/pinyin LIKE '%?%'` | **无法使用索引** | ⭐⭐ 较慢（全表扫描） |
| 组合查询 | `symbol = ? AND market = ?` | 主键索引 + market 索引 | ⭐⭐⭐⭐⭐ 优秀 |
| 组合搜索 | `keyword LIKE '%?%' AND market = ?` | market 索引（减少扫描范围） | ⭐⭐⭐ 一般 |

#### 2.2 LIKE 查询的性能问题

**慢查询示例**：
```sql
-- 全表扫描，无法使用索引
SELECT * FROM stocks WHERE name LIKE '%银行%';
SELECT * FROM stocks WHERE pinyin LIKE '%yhzq%';
```

**优化建议**：
1. **前缀匹配替代**：如果可能，引导用户使用前缀搜索
   ```sql
   -- 可以使用索引
   SELECT * FROM stocks WHERE name LIKE '平安%';
   SELECT * FROM stocks WHERE pinyin LIKE 'payx%';
   ```

2. **限制结果集**：在代码中已实现，最多返回 500 条（MAX_PAGE_SIZE）

3. **组合索引列**：先用索引列过滤（如 market），再进行 LIKE 匹配
   ```sql
   -- 先通过 market 索引过滤，再 LIKE 匹配
   SELECT * FROM stocks WHERE market = 'SH' AND name LIKE '%银行%';
   ```

4. **考虑全文搜索**（高级）：
   - D1 基于 SQLite，支持 FTS5（全文搜索）
   - 需要创建虚拟表，适合大规模文本搜索

### 3. COUNT 查询优化

#### 3.1 当前实现

每次查询都执行 `SELECT COUNT(*) FROM stocks WHERE ...`，这在大表上可能较慢。

#### 3.2 优化策略

**策略 1：精确查询跳过 COUNT**
```typescript
// 对于 symbol 精确查询，total 最多为 1
if (symbol && !market) {
    // 直接设置 total = 1，跳过 COUNT 查询
}
```

**策略 2：缓存总数**
```typescript
// 对于全量分页（无筛选条件），可以缓存总数
if (!symbol && !keyword && !market) {
    // 从 KV 缓存读取总数（TTL 1小时）
    // 数据库更新时清除缓存
}
```

**策略 3：使用近似计数**（仅当数据量巨大时）
```sql
-- 使用 SQLite 统计信息估算
SELECT stat FROM sqlite_stat1 WHERE tbl='stocks';
```

### 4. 推荐的索引创建顺序

根据查询频率和性能影响，建议按以下顺序创建索引：

```bash
# 1. 优先：market 索引（最常用的筛选条件）
wrangler d1 execute aistock --command="CREATE INDEX IF NOT EXISTS idx_stocks_market ON stocks(market);"

# 2. 可选：如果有前缀拼音搜索需求
wrangler d1 execute aistock --command="CREATE INDEX IF NOT EXISTS idx_stocks_pinyin ON stocks(pinyin);"

# 3. 高级：如果组合查询频繁
wrangler d1 execute aistock --command="CREATE INDEX IF NOT EXISTS idx_stocks_market_symbol ON stocks(market, symbol);"
```

### 5. 监控查询性能

#### 5.1 使用 EXPLAIN QUERY PLAN

在本地开发时，可以使用 `EXPLAIN QUERY PLAN` 查看查询计划：

```bash
wrangler d1 execute aistock --command="EXPLAIN QUERY PLAN SELECT * FROM stocks WHERE market = 'SH' ORDER BY symbol LIMIT 50;"
```

输出示例：
```
SEARCH stocks USING INDEX idx_stocks_market (market=?)  # 使用了索引
USE TEMP B-TREE FOR ORDER BY                            # ORDER BY 需要临时排序
```

#### 5.2 查看索引列表

```bash
wrangler d1 execute aistock --command="SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='stocks';"
```

### 6. 生产环境建议

1. **创建必要索引**：至少创建 `market` 索引
2. **监控慢查询**：在 Worker 中记录超过 100ms 的查询
3. **设置合理的分页大小**：避免一次返回过多数据
4. **考虑读写分离**：已使用 D1 Sessions API 实现读复制
5. **定期分析查询模式**：根据实际使用情况调整索引策略

### 7. 数据量增长应对

当股票数量增长到数万条时：

1. **索引优化**：
   - ✅ 已创建的索引会自动生效
   - 考虑删除不常用的索引（减少写入开销）

2. **查询优化**：
   - 限制 LIKE 搜索的最大结果数
   - 考虑引入专门的搜索服务（如 Algolia、Elasticsearch）

3. **分片策略**：
   - 按市场分表：`stocks_sh`、`stocks_sz`、`stocks_bj`
   - 在应用层路由查询

4. **缓存策略**：
   - 热门查询结果缓存到 KV（TTL 5-60分钟）
   - 全量列表缓存（定期更新）

## 总结

**立即执行**：
```bash
# 创建 market 索引（强烈推荐）
wrangler d1 execute aistock --command="CREATE INDEX IF NOT EXISTS idx_stocks_market ON stocks(market);"
```

**性能提升预期**：
- 按市场筛选查询：**10-100倍** 提升（取决于数据量）
- 组合查询（symbol + market）：**5-50倍** 提升
- 全量分页和精确查询：**无明显变化**（已使用主键索引）
- LIKE 搜索：**轻微提升**（如果先通过 market 索引过滤）
