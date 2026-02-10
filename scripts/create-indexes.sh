#!/bin/bash
# D1 数据库索引创建脚本
# 用途：为 stocks 表创建性能优化索引

set -e  # 遇到错误立即退出

echo "🚀 开始创建 D1 数据库索引..."
echo ""

# 数据库名称
DB_NAME="aistock"

# 1. 创建 market 索引（强烈推荐）
echo "📊 创建 market 索引..."
wrangler d1 execute $DB_NAME --command="CREATE INDEX IF NOT EXISTS idx_stocks_market ON stocks(market);"
echo "✅ market 索引创建成功"
echo ""

# 2. 创建 pinyin 索引（可选，如果有前缀拼音搜索需求）
read -p "❓ 是否创建 pinyin 索引？(y/N): " create_pinyin
if [[ $create_pinyin =~ ^[Yy]$ ]]; then
    echo "📊 创建 pinyin 索引..."
    wrangler d1 execute $DB_NAME --command="CREATE INDEX IF NOT EXISTS idx_stocks_pinyin ON stocks(pinyin);"
    echo "✅ pinyin 索引创建成功"
    echo ""
fi

# 3. 创建组合索引（高级，如果组合查询频繁）
read -p "❓ 是否创建 market+symbol 组合索引？(y/N): " create_composite
if [[ $create_composite =~ ^[Yy]$ ]]; then
    echo "📊 创建 market+symbol 组合索引..."
    wrangler d1 execute $DB_NAME --command="CREATE INDEX IF NOT EXISTS idx_stocks_market_symbol ON stocks(market, symbol);"
    echo "✅ 组合索引创建成功"
    echo ""
fi

# 验证索引
echo "🔍 验证索引创建结果..."
wrangler d1 execute $DB_NAME --command="SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='stocks';"

echo ""
echo "🎉 索引创建完成！性能优化已生效。"
echo ""
echo "💡 提示："
echo "  - market 索引可以显著提升按市场筛选的查询性能（10-100倍）"
echo "  - 查看完整的性能优化指南: docs/D1_PERFORMANCE_OPTIMIZATION.md"
