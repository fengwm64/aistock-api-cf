#!/bin/bash

# D1 数据库初始化脚本

echo "=== Cloudflare D1 数据库初始化 ==="
echo ""

# 检查是否已创建数据库
echo "步骤 1: 创建 D1 数据库"
echo "执行命令: wrangler d1 create aistock"
echo ""
echo "请手动执行上述命令，并将返回的 database_id 填入 wrangler.toml"
echo "按回车键继续到下一步..."
read

echo ""
echo "步骤 2: 初始化数据库表和数据"
echo "执行命令: wrangler d1 execute aistock --file=./scripts/stocks.sql"
wrangler d1 execute aistock --file=./scripts/stocks.sql
echo "执行命令: wrangler d1 execute aistock --file=./scripts/earnings_forecast.sql"
wrangler d1 execute aistock --file=./scripts/earnings_forecast.sql
echo "执行命令: wrangler d1 execute aistock --file=./scripts/stock_analysis.sql"
wrangler d1 execute aistock --file=./scripts/stock_analysis.sql

echo ""
echo "步骤 3: 验证数据"
echo "查询股票总数..."
wrangler d1 execute aistock --command="SELECT COUNT(*) as count FROM stocks"
echo "查询分析表是否创建..."
wrangler d1 execute aistock --command="SELECT name FROM sqlite_master WHERE type='table' AND name='stock_analysis'"
echo "查询盈利预测表是否创建..."
wrangler d1 execute aistock --command="SELECT name FROM sqlite_master WHERE type='table' AND name='earnings_forecast'"

echo ""
echo "查询前 5 条数据..."
wrangler d1 execute aistock --command="SELECT * FROM stocks LIMIT 5"

echo ""
echo "=== 初始化完成 ==="
echo "你可以使用以下命令查询数据："
echo "  wrangler d1 execute aistock --command=\"SELECT * FROM stocks WHERE symbol='000001'\""
