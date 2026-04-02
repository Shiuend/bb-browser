# 功能評估：網站綁定 Tab + URL 驅動腳本注入

## 需求摘要

1. **單一網站 → 固定 Tab**：對某個網站（如 `example.com`），永遠重用同一個 tab，不會開新的
2. **URL → 腳本映射**：根據當前頁面的 URL 決定注入哪個 script 檔案（而非現在固定的 `buildDomTree.js`）
3. **頁面導航無需訊息傳遞**：腳本注入由 URL 變化自動觸發，不需要 CLI 主動下指令
4. **與現有功能並存**：不影響現有的 `open`、`snapshot`、`click` 等指令

---

## 架構可行性：高

現有架構已經具備關鍵基礎：

| 需求 | 現有基礎 | 需要新增 |
|------|----------|----------|
| Tab 重用 | `TabStateManager` 已追蹤所有 tab，有 `shortId` 機制 | 新增 site → targetId 的映射表 |
| URL 變化偵測 | CDP 已啟用 `Page` domain，可監聽 `Page.frameNavigated` | 加入事件監聽 + URL match 邏輯 |
| 腳本注入 | `Runtime.evaluate` 已用於注入 `buildDomTree.js` | 擴展為可載入任意腳本檔 |
| 導航時自動觸發 | daemon 已接收 CDP 事件流 | 在事件處理中加入自動注入邏輯 |

---

## 建議設計

### 1. 設定檔定義映射規則

```jsonc
// ~/.bb-browser/site-scripts.json
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
    }
  ]
}
```

### 2. 核心變更點

- **`tab-state.ts`**：`TabStateManager` 新增 `siteTabMap: Map<string, string>`（site pattern → targetId），在 `open` 時查表決定是否重用
- **`cdp-connection.ts`**：監聽 `Page.frameNavigated`，比對 URL，觸發腳本注入
- **`command-dispatch.ts`**：擴展腳本載入邏輯，從固定的 `buildDomTree.js` 改為依 URL 查表載入對應腳本
- **`protocol.ts`**：可能新增 `site_bind` action type（可選，也可純靠設定檔）

### 3. 導航時自動注入的流程

```
Page.frameNavigated 事件
  → 取得新 URL
  → 比對 site-scripts.json 的 match 規則
  → 若命中：讀取對應 script 檔案 → Runtime.evaluate 注入
  → 若未命中：不做任何事（現有行為不變）
```

---

## 需要注意的問題

1. **注入時機**：`Page.frameNavigated` 觸發時 DOM 可能尚未就緒，需搭配 `Page.loadEventFired` 或 `Page.domContentEventFired` 確保腳本在 DOM ready 後執行
2. **SPA 導航**：單頁應用不會觸發 `frameNavigated`，需額外監聽 `Page.navigatedWithinDocument`（history pushState）
3. **Tab 生命週期**：當使用者手動關閉 reuse tab，`siteTabMap` 需同步清除（可在 `Target.detachedFromTarget` 中處理）
4. **腳本安全性**：注入任意腳本到頁面有安全風險，需限制腳本來源目錄（如只允許 `~/.bb-browser/scripts/`）
5. **多規則衝突**：同一 URL 可能匹配多條規則，需定義優先順序（建議 first-match）

---

## 工作量評估

- **核心功能**（tab 重用 + URL 腳本注入 + 自動觸發）：中等，主要改動集中在 daemon 的 3-4 個檔案
- **設定檔解析 + 驗證**：小
- **SPA 支援**：小，但容易遺漏
- **測試**：中等，需覆蓋導航、重用、SPA、tab 關閉等場景

---

## 結論

這個功能與現有架構高度契合，不需要大幅重構。核心思路是在 daemon 的 CDP 事件處理層加入「URL → 腳本」的響應式邏輯，並在 `TabStateManager` 中加入 site 綁定。最大的風險點是 **注入時機**（DOM ready）和 **SPA 導航偵測**，建議優先處理這兩點。
