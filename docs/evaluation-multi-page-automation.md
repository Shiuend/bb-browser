# 評估：單一網站多頁連續操作（Multi-Page Automation）

## 需求摘要

針對**單一網站**進行連續操作，頁面必須延續（同一 tab），每個頁面使用不同的 script（adapter）。

典型場景：
- 電商：搜尋商品 → 進入商品頁 → 加入購物車 → 結帳
- 社群：登入 → 搜尋用戶 → 查看個人檔案 → 發送訊息
- 表單：填寫第一頁 → 下一步 → 填寫第二頁 → 提交

---

## 現有架構能力分析

### 已具備的基礎

| 能力 | 狀態 | 實作位置 |
|------|------|----------|
| Tab 持久化 | ✅ 完整支援 | `daemon/tab-state.ts` — TabState 物件生命週期跟隨 tab |
| 指定 tab 執行 | ✅ 所有命令接受 `tabId` | `protocol.ts:70` — Request.tabId |
| 域名自動匹配 tab | ✅ adapter 自動複用同域名 tab | `site.ts:651-674` — matchTabOrigin() |
| 頁面導航後狀態保留 | ✅ Cookie/Session 自然延續 | 使用真實 Chrome，登入狀態內建 |
| 任意 JS 執行 | ✅ eval 可在任何頁面執行 | `command-dispatch.ts:750-759` |
| 序列號追蹤 | ✅ 全域遞增 seq | `tab-state.ts` — nextSeq() |
| 網路/Console 增量查詢 | ✅ since + cursor 機制 | `tab-state.ts:128-181` |

### 現有可行的工作流（手動串接）

目前 Agent（AI 或腳本）可以透過**逐步呼叫**實現多頁操作：

```bash
# 步驟 1：打開網站（取得 tabId）
bb-browser open https://shop.example.com
# → tabId: "abc123", tab: "a1b2"

# 步驟 2：搜尋頁面 — 用 adapter A
bb-browser site shop/search "laptop" --tab a1b2

# 步驟 3：頁面已跳轉到搜尋結果 → 用 adapter B
bb-browser site shop/get-results --tab a1b2

# 步驟 4：點擊第一個商品（頁面導航）
bb-browser click 5 --tab a1b2

# 步驟 5：商品詳情頁 → 用 adapter C
bb-browser site shop/product-detail --tab a1b2
```

**關鍵觀察**：這在技術上已經可行，但需要外部編排（Agent 或 shell script）。

---

## 缺口分析

### 缺口 1：無內建 Pipeline/Workflow 定義

目前沒有宣告式的方式描述「步驟 A → 步驟 B → 步驟 C」。每次多頁操作都需要外部編排器。

**影響**：
- Agent 必須逐步呼叫，增加 LLM token 消耗和延遲
- 無法重複使用已定義的工作流
- 錯誤恢復邏輯散落在外部

### 缺口 2：步驟間資料傳遞無標準機制

Adapter A 的輸出無法自動成為 Adapter B 的輸入。目前必須：
1. Adapter A 返回 JSON
2. 外部解析結果
3. 將需要的值作為參數傳給 Adapter B

**影響**：每個 adapter 是孤立的 `(args) => result`，無 pipeline context。

### 缺口 3：頁面導航等待缺乏智慧機制

步驟間的頁面跳轉（如點擊後頁面載入）缺乏自動等待：
- `wait` 命令只支援固定時間或 network idle
- 沒有「等待 URL 變化到指定 pattern」的原子操作
- 沒有「等待特定元素出現」的便捷方式

### 缺口 4：adapter 無法宣告「此 adapter 需要在特定頁面狀態下執行」

現有 `@meta` 只有 `domain` 欄位，無法表達：
- 前置條件：「需要在搜尋結果頁」
- URL pattern 匹配：`/search?q=*`
- 必須先執行的步驟

---

## 設計方案

### 方案 A：Pipeline Adapter（推薦）

在現有 adapter 格式上擴充，新增 `pipeline` 類型的 adapter：

```javascript
/* @meta
{
  "name": "shop/buy-flow",
  "description": "搜尋商品並加入購物車",
  "domain": "shop.example.com",
  "type": "pipeline",
  "args": {
    "query": { "required": true, "description": "搜尋關鍵字" },
    "index": { "required": false, "description": "選取第幾個結果（預設 0）" }
  }
}
*/
async function(args, ctx) {
  // 步驟 1：搜尋
  await ctx.navigate(`/search?q=${encodeURIComponent(args.query)}`);
  await ctx.waitForSelector('.search-results');

  // 步驟 2：取得結果（在搜尋結果頁執行）
  const results = await ctx.eval(`
    Array.from(document.querySelectorAll('.product-card')).map(el => ({
      name: el.querySelector('.title').textContent,
      price: el.querySelector('.price').textContent,
      url: el.querySelector('a').href
    }))
  `);

  // 步驟 3：點擊指定商品（頁面導航）
  const idx = parseInt(args.index || '0');
  await ctx.navigate(results[idx].url);
  await ctx.waitForSelector('.product-detail');

  // 步驟 4：在商品頁執行
  const detail = await ctx.eval(`({
    name: document.querySelector('h1').textContent,
    price: document.querySelector('.price').textContent,
    inStock: !!document.querySelector('.in-stock')
  })`);

  return { searched: args.query, selected: results[idx], detail };
}
```

**實作要點**：
- `ctx` 物件提供 `navigate()`, `waitForSelector()`, `eval()`, `click()` 等方法
- 所有操作在**同一 tab** 內執行，頁面自然延續
- ctx 內部透過 daemon HTTP API 執行 CDP 命令
- 與現有 adapter 格式向後相容（普通 adapter 無 `ctx` 參數）

**需要修改的檔案**：
1. `packages/cli/src/commands/site.ts` — 偵測 `type: "pipeline"`，注入 ctx
2. `packages/shared/src/protocol.ts` — 不需修改（使用現有 action）
3. `packages/mcp/src/index.ts` — `site_run` 無需修改（透明支援）

### 方案 B：宣告式 YAML Workflow

```yaml
# ~/.bb-browser/workflows/shop-buy.yaml
name: shop/buy-flow
domain: shop.example.com
args:
  query: { required: true }

steps:
  - name: search
    script: shop/search
    args: { query: "{{args.query}}" }

  - name: select
    wait: { selector: ".search-results" }
    script: shop/get-results

  - name: detail
    navigate: "{{steps.select.result[0].url}}"
    wait: { selector: ".product-detail" }
    script: shop/product-detail
```

**優點**：宣告式、可視化、易於分享
**缺點**：需要新的解析器、模板引擎、步驟引用語法，複雜度高

### 方案 C：維持現狀，強化 Agent 編排

不修改核心，而是：
1. 提供更好的 MCP tool 描述，引導 Agent 串接
2. 加入 `waitForNavigation` 和 `waitForSelector` 原子命令
3. 文件記錄常見的多頁操作模式

**優點**：零改動、利用 AI Agent 的靈活性
**缺點**：每次都需要 Agent 理解並編排，token 消耗大

---

## 建議與優先級

### 推薦採用方案 A（Pipeline Adapter），分兩階段實施：

#### 第一階段：基礎 Pipeline 支援（影響小、價值高）

1. **新增 `waitForSelector` action**（daemon 層）
   - 位置：`protocol.ts` 新增 action type、`command-dispatch.ts` 實作
   - 用途：等待指定 CSS selector 出現，支援 timeout
   - 預估改動：~50 行

2. **新增 `waitForNavigation` action**（daemon 層）
   - 監聽 `Page.frameNavigated` 事件直到 URL 匹配指定 pattern
   - 預估改動：~40 行

3. **Pipeline adapter 執行器**（CLI 層）
   - 在 `site.ts:siteRun()` 中偵測 `type: "pipeline"`
   - 構建 `ctx` 物件，方法內部呼叫 `sendCommand()`
   - 預估改動：~120 行

#### 第二階段：增強功能

4. **步驟間錯誤恢復**：ctx.retry()、條件分支
5. **Pipeline 組合**：一個 pipeline 呼叫另一個 pipeline
6. **MCP 直接支援**：`site_run_pipeline` 或在 `site_run` 中透明支援

### 可行性評估

| 面向 | 評估 |
|------|------|
| 技術可行性 | **高** — 所有底層能力已存在（tab 持久化、eval、導航、事件追蹤） |
| 改動範圍 | **小** — 核心 protocol 無需大改，主要在 CLI 層新增執行器 |
| 向後相容 | **完全相容** — 現有 adapter 不受影響 |
| 使用者體驗 | 與現有 `bb-browser site <name>` 完全一致 |
| 風險 | **低** — pipeline 內部使用現有 sendCommand，不引入新通道 |

### 結論

**此功能完全可行且建議實施**。現有架構已具備所有底層基礎（tab 持久化、指定 tab 執行、eval、導航），只需在 CLI 層新增 Pipeline 執行器和兩個等待類 action。方案 A 的 `ctx` 物件模式既保持了 adapter 的簡單性，又提供了多頁操作的完整能力。
