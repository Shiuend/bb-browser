# 實作紀錄：網站綁定 Tab + URL 驅動腳本注入

> Commit: `49f73fd`  
> Branch: `dev_test`

---

## 功能概述

根據 `docs/site-bound-tab-evaluation.md` 的設計，實作以下三項核心功能：

1. **網站 → 固定 Tab**：對設定檔中的網站，`open` 指令永遠重用同一個 tab
2. **URL → 腳本映射**：根據當前頁面 URL 自動注入對應的 script 檔案
3. **導航自動觸發**：腳本注入由 CDP 導航事件驅動，無需 CLI 主動下指令

---

## 設定檔格式

### `~/.bb-browser/site-scripts.json`

```jsonc
{
  "sites": [
    {
      "match": "https://mail.google.com/**",
      "scripts": ["gmail-helper.js"],
      "reuseTab": true
    },
    {
      "match": "https://github.com/*/pull/*",
      "scripts": ["pr-review.js"],
      "reuseTab": true
    },
    {
      "match": "https://github.com/**",
      "scripts": ["github.js"],
      "reuseTab": false
    }
  ]
}
```

### 腳本存放位置

```
~/.bb-browser/scripts/
├── gmail-helper.js
├── pr-review.js
└── github.js
```

- 腳本以 IIFE 方式注入頁面：`(() => { <script content> })()`
- 僅允許此目錄下的檔案，拒絕路徑穿越（`..`、絕對路徑）

---

## URL Match 規則

| 模式 | 說明 | 範例 |
|------|------|------|
| `https://example.com/page` | 完全比對 | 僅匹配 `/page` |
| `https://example.com/**` | 任意路徑 | 匹配所有路徑 |
| `https://example.com/*/detail` | 單一段落萬用字元 | 匹配 `/foo/detail`，不匹配 `/foo/bar/detail` |
| `https://github.com/*/pull/*` | 多段萬用字元 | 匹配 `/user/pull/123` |

- **First-match**：多條規則同時符合時，以第一條為準
- Protocol 與 Host 皆須完全匹配

---

## 新增 / 修改的檔案

### 新建：`packages/daemon/src/site-scripts.ts`

核心工具模組，提供：

| 函式 | 說明 |
|------|------|
| `loadSiteScriptsConfig()` | 讀取設定檔，5 秒 mtime 快取避免頻繁 fs 讀取，檔案不存在時回傳空設定 |
| `matchUrl(url, config)` | 對 URL 進行 first-match，回傳命中的規則或 `null` |
| `matchUrlPattern(url, pattern)` | 單一規則比對，支援 `*` / `**` 萬用字元 |
| `loadUserScript(name)` | 從 `~/.bb-browser/scripts/` 讀取腳本，含路徑安全驗證與快取 |
| `resetConfigCache()` / `resetScriptCache()` | 測試用快取清除 |

---

### 修改：`packages/daemon/src/tab-state.ts`

**`TabState` 新增欄位：**

```typescript
/** 來自 Page.frameNavigated 的 URL，等待 domContentEventFired 後觸發注入 */
pendingNavigationUrl: string | null = null;
```

**`TabStateManager` 新增：**

```typescript
// 站點模式 → targetId 映射
private siteTabMap: Map<string, string>

bindSiteTab(pattern: string, targetId: string): void
getSiteTab(pattern: string): string | undefined
unbindSiteTab(targetId: string): void  // removeTab() 時自動呼叫
```

---

### 修改：`packages/daemon/src/cdp-connection.ts`

在 `handleSessionEvent()` 中新增三個 CDP 事件處理：

```
Page.frameNavigated
  → 僅處理主框架（無 parentId）
  → 儲存 URL 至 tab.pendingNavigationUrl
  → 不立即注入（DOM 尚未就緒）

Page.domContentEventFired
  → DOM 解析完成
  → 取出 pendingNavigationUrl → 觸發 scheduleSiteScriptInjection()
  → 清除 pendingNavigationUrl

Page.navigatedWithinDocument
  → SPA pushState/replaceState 導航
  → DOM 已存在，直接觸發 scheduleSiteScriptInjection()
```

**防重複注入（Debounce）：**
- 每個 tab 設有 100ms debounce timer
- 解決重新導向鏈（A→B→C）可能觸發多次注入的問題

**注入方法 `injectSiteScripts(targetId, url)`：**
1. 載入設定檔，比對 URL
2. 若有 `reuseTab: true`，呼叫 `tabManager.bindSiteTab()`
3. 依序注入 `rule.scripts` 中的每個腳本
4. 注入失敗靜默處理，不中斷 tab 運作

---

### 修改：`packages/daemon/src/command-dispatch.ts`

`open` 指令在 `tabRef === undefined`（未指定 tab）時的新邏輯：

```
比對 site-scripts.json
  → 有 reuseTab 規則 + 已有綁定的 targetId + session 仍存在
    → Page.navigate 到既有 tab（重用）
  → 有 reuseTab 規則但尚無綁定
    → 正常建立新 tab → 完成後呼叫 bindSiteTab()
  → 無命中規則
    → 原有行為不變（建立新 tab）
```

---

## 導航事件處理流程

### 完整頁面載入

```
使用者瀏覽 https://mail.google.com/inbox
  │
  ├─ Page.frameNavigated (frame.url = "https://mail.google.com/inbox")
  │    └─ tab.pendingNavigationUrl = URL（DOM 未就緒，暫存）
  │
  └─ Page.domContentEventFired
       └─ 取出 pendingNavigationUrl
            └─ matchUrl() 命中規則 → 100ms debounce
                 └─ loadUserScript("gmail-helper.js")
                      └─ Runtime.evaluate: (() => { <script> })()
```

### SPA 導航（pushState）

```
Gmail 切換頁籤（無完整頁面載入）
  │
  └─ Page.navigatedWithinDocument (url = 新 URL)
       └─ matchUrl() 命中規則 → 100ms debounce
            └─ 直接注入（DOM 已存在）
```

### Tab 重用（第二次 open）

```
bb open https://mail.google.com/sent
  │
  └─ tabRef 未指定 → 比對設定檔
       └─ reuseTab: true + getSiteTab() = "target-abc"
            └─ hasSession("target-abc") = true
                 └─ Page.navigate（重用現有 tab）
```

---

## 測試

新增測試檔：`packages/daemon/src/__tests__/site-scripts.test.ts`

| 測試群組 | 測試數 | 涵蓋範圍 |
|---------|--------|---------|
| `matchUrlPattern` | 10 | 精確比對、`*`、`**`、協定不符、Host 不符、路徑不符、無效 URL |
| `matchUrl` | 5 | First-match 優先順序、無命中、空設定 |
| `TabStateManager site-tab binding` | 5 | 綁定/查詢、重寫、tab 關閉自動清除、no-op |
| `TabState.pendingNavigationUrl` | 3 | 預設值、設值、清除 |

**執行結果：**

```
# tests 134  (新增 23 個)
# pass  121
# fail    0
# skipped 13  (integration tests，需要真實 Chrome)
```

---

## 安全考量

| 項目 | 處置方式 |
|------|---------|
| 路徑穿越攻擊 | 拒絕含 `..`、絕對路徑、null byte 的腳本名稱 |
| 腳本來源限制 | 僅允許 `~/.bb-browser/scripts/` 目錄 |
| 解析路徑二次驗證 | `path.resolve()` 後確認仍在 `SCRIPTS_DIR` 內 |
| 注入失敗處理 | try/catch 靜默處理，不影響正常 tab 運作 |

---

## 已知限制

1. **注入時機**：`domContentEventFired` 後 DOM 已解析，但動態載入的內容尚未存在；用戶腳本若需等待特定元素，需自行實作等待邏輯
2. **設定檔熱重載**：5 秒快取，修改後最多 5 秒生效，無需重啟 daemon
3. **腳本快取**：載入後永久快取至 daemon 重啟；修改腳本後需重啟 daemon

---

## 手動驗證步驟

### 1. 準備測試環境

```bash
mkdir -p ~/.bb-browser/scripts

# 建立測試腳本（注入後在 console 留下記號並修改 title）
cat > ~/.bb-browser/scripts/test-inject.js << 'EOF'
console.log('[bb-browser] site-script injected:', window.location.href);
document.title = '[INJECTED] ' + document.title;
EOF

# 建立設定檔
cat > ~/.bb-browser/site-scripts.json << 'EOF'
{
  "sites": [
    {
      "match": "https://example.com/**",
      "scripts": ["test-inject.js"],
      "reuseTab": true
    }
  ]
}
EOF
```

### 2. 重啟 daemon（載入新設定）

```bash
bb shutdown
bb status    # 確認重新啟動
```

### 3. 驗證腳本自動注入

```bash
bb open https://example.com

# 確認 title 被腳本修改
bb snapshot
# 預期：title 開頭含 "[INJECTED]"

# 確認注入 log 存在
bb console
# 預期：看到 "[bb-browser] site-script injected: https://example.com/"
```

### 4. 驗證 Tab 重用

```bash
# 第一次開啟，記下回傳的 tab id（假設是 "ab12"）
bb open https://example.com
# 輸出: { "tab": "ab12", ... }

# 第二次開啟同一網站
bb open https://example.com
# 預期：tab id 與第一次相同（"ab12"），沒有開新 tab

bb tab list
# 預期：tab 數量未增加
```

### 5. 驗證非設定網站不受影響

```bash
bb open https://httpbin.org
# 預期：開新 tab，tab id 與前面不同

bb console
# 預期：無注入 log
```

### 6. 驗證 SPA 導航（pushState）

在設定檔加入 GitHub 規則後測試：

```bash
bb open https://github.com/trending
bb eval "history.pushState({}, '', '/explore')"
bb console
# 預期：出現新的注入 log，URL 為 /explore
```

### 7. 驗證 Tab 關閉後重新綁定

```bash
bb open https://example.com    # 記下 tab id，假設 "ab12"
bb tab close ab12              # 關閉該 tab
bb open https://example.com    # 再次開啟
# 預期：建立新 tab（新 id），並重新綁定
```

---

## 驗證清單

| 項目 | 指令 | 預期結果 |
|------|------|---------|
| 腳本注入 | `bb open <matched>` → `bb snapshot` | title 含 `[INJECTED]` |
| 注入 log | `bb console` | 有 `[bb-browser] site-script injected` |
| Tab 重用 | 第二次 `bb open <matched>` | 回傳相同 tab id |
| 非設定網站 | `bb open <unmatched>` → `bb console` | 無注入 log，開新 tab |
| SPA 導航 | `bb eval "history.pushState(...)"` → `bb console` | 出現新注入 log |
| Tab 關閉重綁 | 關閉後再 `bb open` | 建立新 tab 並重新綁定 |
