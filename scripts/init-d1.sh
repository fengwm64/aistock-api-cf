#!/bin/bash

# D1 数据库初始化脚本
set -euo pipefail

DB_NAME="${1:-aistock}"

if ! command -v wrangler >/dev/null 2>&1; then
    echo "未检测到 wrangler，请先安装后再执行。"
    exit 1
fi

SQL_FILES=(
    "./scripts/stocks.sql"
    "./scripts/users.sql"
    "./scripts/user_settings.sql"
    "./scripts/scan_login.sql"
    "./scripts/tags.sql"
    "./scripts/news_tags.sql"
    "./scripts/stock_tags.sql"
    "./scripts/earnings_forecast.sql"
    "./scripts/stock_analysis.sql"
)

echo "=== Cloudflare D1 数据库初始化 ==="
echo "目标数据库: ${DB_NAME}"
echo ""

# 检查是否已创建数据库
echo "步骤 1: 创建 D1 数据库（如已创建可跳过）"
echo "执行命令: wrangler d1 create ${DB_NAME}"
echo ""
echo "请确认已创建数据库并将 database_id 填入 wrangler.toml"
echo "按回车键继续到下一步..."
read

echo ""
echo "步骤 2: 初始化数据库表和数据"
for file in "${SQL_FILES[@]}"; do
    if [[ ! -f "${file}" ]]; then
        echo "未找到 SQL 文件: ${file}"
        exit 1
    fi

    echo "执行命令: wrangler d1 execute ${DB_NAME} --file=${file}"
    wrangler d1 execute "${DB_NAME}" --file="${file}"
done

echo ""
echo "步骤 3: 验证数据"
echo "检查关键表..."
wrangler d1 execute "${DB_NAME}" --command="
SELECT name
FROM sqlite_master
WHERE type='table'
  AND name IN (
    'stocks', 'users', 'user_stocks', 'user_settings',
    'scan_login_states', 'tags', 'news_tags',
    'earnings_forecast', 'stock_analysis'
  )
ORDER BY name;"

echo ""
echo "查询股票总数..."
wrangler d1 execute "${DB_NAME}" --command="SELECT COUNT(*) AS count FROM stocks;"
echo "查询标签总数..."
wrangler d1 execute "${DB_NAME}" --command="SELECT COUNT(*) AS count FROM tags;"

echo ""
echo "查询前 5 条股票数据..."
wrangler d1 execute "${DB_NAME}" --command="SELECT * FROM stocks LIMIT 5;"
echo "查询前 5 条标签数据..."
wrangler d1 execute "${DB_NAME}" --command="SELECT * FROM tags LIMIT 5;"

echo ""
echo "=== 初始化完成 ==="
echo "示例："
echo "  wrangler d1 execute ${DB_NAME} --command=\"SELECT * FROM stocks WHERE symbol='000001'\""
