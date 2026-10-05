# duo-page（一頁雙聲）交接

> 給任何接手的模型。使用者是阿福，一律用繁體中文回覆。
> 品味鐵則、雙客服的設計與技術細節，以 `~/Documents/web/project/ocean-life/HANDOFF.md` 為準，這裡只記 duo-page 自己的事。
> 改完東西，把新的決定、PR 編號補進這份文件。

## 0. 狀態

- 2026-10-05：初始化，銷售頁第一版直接推 main。
- 之後每次改動都開 PR、給 Vercel 預覽網址，等阿福說「合併」。
- **Vercel 專案由阿福自己建**（匯入 `fux-ui/duo-page`），金鑰也是他設，模型不碰。

## 1. 檔案

| 檔案 | 做什麼 |
|---|---|
| `site/index.html` | 銷售頁全部的 CSS 與標記；客服 CSS 與 `#chat` 標記沿用 ocean-life |
| `site/chat.js` | 客服前端，沿用 ocean-life；召喚鍵改成 `[data-chat]`，按鈕直接顯示（沒有 `app.js`） |
| `api/chat.js` | 串流 proxy（Gemini 直連／Anthropic／AI Gateway），沿用 ocean-life，**拿掉了 Jev**（Jev 是 C 方案的東西） |
| `api/_kb.js` | 客服說什麼：`FACTS`＝方案、流程、AI 費用；`OPEN`＝價格、時程、合約等轉阿福的主題 |
| `server.js` | 本機預覽，預設 port **8849**（8848 留給 ocean-life） |

## 2. 銷售頁段落

開場（可直接聊）→ 01 痛點 → 02 實例（ocean2life）→ 03 雙客服怎麼運作 → 04 方案＋比較表＋加購 → 05 流程 → 06 常見問題 → 預約諮詢（雙客服接，轉 LINE）→ 頁尾。

- 價格一律「洽詢」；方案內容是草案，`_kb.js` 也要求貓說「以阿福確認為準」。
- 時程沒有定，頁面與知識庫都只寫「諮詢時一起排」，不要自己填天數。
- 頁面上的對話泡泡都標了「示意」，不是真的對話紀錄。

## 3. 驗證

```bash
node --check site/chat.js && node --check api/chat.js && node --check api/_kb.js
node server.js   # http://localhost:8849
```
本機沒有金鑰時，客服會回「線上客服還沒開機」並給 LINE，這是正常的。人格改動要在正式站用 curl 測（同 ocean-life）。

## 4. 還要阿福補的

- 在 Vercel 匯入 repo，設 `AI_GATEWAY_API_KEY`、`AI_GATEWAY_BASE_URL`、`AI_GATEWAY_MODEL`（或 `GEMINI_API_KEY`），並設 AI 每月花費上限。
- 三個方案的實際價格、方案內容定稿、有沒有自己的網域。
- 網域定了之後補 `canonical`、`og:url`，`og:image` 改成絕對網址。
