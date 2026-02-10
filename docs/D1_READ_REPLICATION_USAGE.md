# D1 读复制使用示例

本示例展示如何在客户端使用 D1 Sessions API 的 bookmark 机制。

## 基本用法

### 第一次请求（无 bookmark）

```bash
# 第一次请求，不带 bookmark
curl -i "https://extapi.aistocklink.cn/api/cn/stocks?page=1&pageSize=10"
```

响应头会包含新的 bookmark：
```
x-d1-bookmark: eyJ0aW1lc3RhbXAiOjE3MDczODc2...
```

### 后续请求（带 bookmark）

```bash
# 使用上次响应的 bookmark
curl -i -H "x-d1-bookmark: eyJ0aW1lc3RhbXAiOjE3MDczODc2..." \
  "https://extapi.aistocklink.cn/api/cn/stocks?page=2&pageSize=10"
```

## 在前端应用中使用

### JavaScript/TypeScript 示例

```typescript
class StockAPI {
  private bookmark: string | null = null;

  async getStocks(page: number = 1, pageSize: number = 50) {
    const url = new URL('https://extapi.aistocklink.cn/api/cn/stocks');
    url.searchParams.set('page', page.toString());
    url.searchParams.set('pageSize', pageSize.toString());

    const headers: HeadersInit = {};
    if (this.bookmark) {
      headers['x-d1-bookmark'] = this.bookmark;
    }

    const response = await fetch(url, { headers });
    
    // 保存新的 bookmark 用于下次请求
    const newBookmark = response.headers.get('x-d1-bookmark');
    if (newBookmark) {
      this.bookmark = newBookmark;
    }

    return response.json();
  }

  async searchStocks(keyword: string) {
    const url = new URL('https://extapi.aistocklink.cn/api/cn/stocks');
    url.searchParams.set('keyword', keyword);

    const headers: HeadersInit = {};
    if (this.bookmark) {
      headers['x-d1-bookmark'] = this.bookmark;
    }

    const response = await fetch(url, { headers });
    
    const newBookmark = response.headers.get('x-d1-bookmark');
    if (newBookmark) {
      this.bookmark = newBookmark;
    }

    return response.json();
  }

  // 重置会话
  resetSession() {
    this.bookmark = null;
  }
}

// 使用示例
const api = new StockAPI();

// 第1页
const page1 = await api.getStocks(1, 20);
console.log('第1页:', page1.data.股票列表);

// 第2页（会使用上次的 bookmark）
const page2 = await api.getStocks(2, 20);
console.log('第2页:', page2.data.股票列表);

// 搜索（会使用最新的 bookmark）
const searchResults = await api.searchStocks('银行');
console.log('搜索结果:', searchResults.data.股票列表);
```

### React Hook 示例

```typescript
import { useState, useCallback } from 'react';

function useStockAPI() {
  const [bookmark, setBookmark] = useState<string | null>(null);

  const fetchStocks = useCallback(async (params: {
    page?: number;
    pageSize?: number;
    keyword?: string;
    symbol?: string;
  }) => {
    const url = new URL('https://extapi.aistocklink.cn/api/cn/stocks');
    
    if (params.page) url.searchParams.set('page', params.page.toString());
    if (params.pageSize) url.searchParams.set('pageSize', params.pageSize.toString());
    if (params.keyword) url.searchParams.set('keyword', params.keyword);
    if (params.symbol) url.searchParams.set('symbol', params.symbol);

    const headers: HeadersInit = {};
    if (bookmark) {
      headers['x-d1-bookmark'] = bookmark;
    }

    const response = await fetch(url, { headers });
    
    const newBookmark = response.headers.get('x-d1-bookmark');
    if (newBookmark) {
      setBookmark(newBookmark);
    }

    return response.json();
  }, [bookmark]);

  const resetSession = useCallback(() => {
    setBookmark(null);
  }, []);

  return { fetchStocks, resetSession };
}

// 组件中使用
function StockListPage() {
  const { fetchStocks, resetSession } = useStockAPI();
  const [stocks, setStocks] = useState([]);

  const loadPage = async (page: number) => {
    const result = await fetchStocks({ page, pageSize: 20 });
    setStocks(result.data.股票列表);
  };

  return (
    <div>
      <button onClick={() => loadPage(1)}>第1页</button>
      <button onClick={() => loadPage(2)}>第2页</button>
      <button onClick={resetSession}>重置会话</button>
      {/* 显示股票列表 */}
    </div>
  );
}
```

## 监控读复制效果

响应的 `_meta` 字段包含读复制的元数据：

```json
{
  "_meta": {
    "served_by_region": "APAC",
    "served_by_primary": false
  }
}
```

- `served_by_region`: 处理请求的副本所在区域
- `served_by_primary`: 是否由主数据库处理（false 表示由只读副本处理）

## 最佳实践

1. **保持会话连续性**：在同一用户会话中持续使用 bookmark，确保数据一致性
2. **适时重置会话**：用户登出或切换上下文时重置 bookmark
3. **错误处理**：如果请求失败，可以不传递 bookmark 重新开始
4. **缓存 bookmark**：可以将 bookmark 存储在 sessionStorage 或内存中

## 注意事项

- Bookmark 是不透明的字符串，不应尝试解析或修改
- Bookmark 有时间限制，过期后会自动失效
- 本地开发时（`wrangler dev`）不会返回读复制相关的元数据
