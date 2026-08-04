# 澎湖店家確認表單

把原本的 Excel 名單，整理成**依街道分類**的確認表單，並提供一個可以部署到 Render、
多人同時填寫、即時同步的響應式網站。

- 資料來源：`data/原始名單.xlsx`（旅行社 / 旅店 / 餐廳 / 不再名單上新增的 四張分頁）
- 判斷「已發送」的依據：原始檔中**整列有底色**（黃色 `FFFF00`、米色 `FFF2CC`）的店家
- 產出：**326 家店家**、分布於 **6 個鄉鎮市、92 條街道／地區**，其中 **104 家**在原始檔標記為已發送

## 內容

| 檔案 | 說明 |
| --- | --- |
| `澎湖店家確認表單.xlsx` | 離線用的確認表單，三張分頁：街道總覽 / 確認表單 / 待補名單 |
| `data/stores.json` | 解析後的結構化資料，網站與 Excel 表單共用同一份 |
| `scripts/parse_xlsx.py` | 原始 Excel → `data/stores.json` |
| `scripts/build_form_xlsx.py` | `data/stores.json` → 確認表單 Excel |
| `src/`、`public/` | Node + Express 網站（原始名單頁 `/`、新增家數頁 `/new`、API、SSE 即時同步） |

## 街道分類怎麼做的

澎湖地址有兩種寫法，都要能歸進同一個「街道」維度：

| 原始地址 | 分到 |
| --- | --- |
| `880澎湖縣馬公市三多路353號` | 馬公市 · 三多路 |
| `880澎湖縣馬公市西衛里223之1號` | 馬公市 · 西衛（沒有路名時用村里／聚落） |
| `880澎湖縣馬公市西文澳92-53號` | 馬公市 · 西文（`西文澳` → `西文` 等舊地名正規化） |
| `880澎湖縣馬公市24-9號` | 馬公市 · 地址未含街道 |

正規化對照表在 `scripts/parse_xlsx.py` 的 `AREA_ALIAS`（`西文澳→西文`、`鎖管港→鎖港`、
`大赤崁→赤崁`、`港底→成功` 等），要調整分類直接改那裡再重跑腳本即可。

同一家店同時出現在「旅行社」與「全台旅行社名單」時（共 9 組），兩筆都會保留、互相標記
「名單重複」，並讓「已發送」狀態同步，避免看起來像沒聯繫過。**但線上填寫的聯繫狀態是分開
記錄的**——重複的那幾筆需要各自填寫，或擇一填寫即可。

## 本機執行

```bash
npm install
python3 scripts/parse_xlsx.py        # 重新解析 Excel（改了原始名單才需要）
python3 scripts/build_form_xlsx.py   # 重新產生確認表單 Excel
npm start                            # http://localhost:3000
```

## 部署到 Render

目前部署在 **free 方案**（`render.yaml` 就是這個設定）：

| 項目 | 值 |
| --- | --- |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Health Check Path | `/healthz` |
| Region | Singapore |
| Disk | 無 |

**⚠️ free 方案的填寫紀錄不會保留。** 發送狀態存在 `data/status.json`、新增的店家存在
`data/additions.json`，而 free 方案的檔案系統是暫時的——服務休眠重啟或重新部署後，所有人填的
內容和新增的店家都會消失、退回 Excel 的初始狀態。

要長期保留紀錄，把 `render.yaml` 改成 Starter 以上並掛 Persistent Disk（free 不支援）：

```yaml
plan: starter
envVars:
  - key: DATA_DIR
    value: /var/data
disk:
  name: store-status
  mountPath: /var/data
  sizeGB: 1
```

Render 的免費／Starter 方案在閒置後會休眠，第一次開啟頁面約需 30 秒喚醒，屬正常現象。

## 網站功能

網站有兩頁，頂端可互相切換。

**發送狀態有三段：`未發送` → `已發送` → `已張貼`。** 頂端統計把三段分開列，進度條與街道比例
則算「已處理」（已發送 + 已張貼），也就是只要不是未發送就計入。

### `/` 原始名單

- **街道索引**：預設收合，一眼看完 92 條街道的進度（`已處理/總數` + 進度條），點開才看店家
- **即時同步**：任何人改動狀態，其他裝置透過 SSE 立刻更新，不需重新整理；右上角顯示連線狀態
- **篩選**：關鍵字（店名／地址／電話／備註）、鄉鎮市、分類、發送狀態、街道、只看未發送、只看原始底色標記
- **每家店可改**：發送狀態（**未發送 / 已發送 / 已張貼**），選了就自動儲存
- **快捷操作**：一鍵撥號、Google 地圖導航、開啟官網／粉專

### `/new` 新增家數

原始名單以外、在外面跑的時候現場加進來的店家。

- 填店名（必填）、鄉鎮市、街道、地址、電話、發送狀態即可新增
- **街道可以直接打新的**，不限於原始名單的 92 條；沒填街道會歸到「未分類」
- 一樣依「鄉鎮市 · 街道」分區，每區顯示 `已處理/家數`，頂端顯示新增總數
- 連續新增同一條街上的店家時，鄉鎮市／街道會留著不清空
- 可以改狀態、刪除；一樣即時同步到其他裝置

手機優先設計，平板／桌機自動變成多欄。

**新增的店家和原始名單是分開存的**（`$DATA_DIR/additions.json`），因為 `data/stores.json`
是 Excel 產生的唯讀資料，重新匯入名單時不能被新增的內容蓋掉。

## API

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| `GET` | `/api/data` | 原始名單完整快照（店家、街道分組、統計、下拉選項） |
| `GET` | `/api/stores/:id` | 單一店家 |
| `PATCH` | `/api/stores/:id` | 更新 `status` / `contactedAt` / `channel` / `owner` / `reply` |
| `GET` | `/api/additions` | 新增名單快照（依街道分區的 `groups`、`summary`、下拉選項） |
| `POST` | `/api/additions` | 新增一家（`name` 必填，另可帶 `address` / `phone` / `town` / `street` / `status`） |
| `PATCH` | `/api/additions/:id` | 更新新增的店家，欄位同上 |
| `DELETE` | `/api/additions/:id` | 刪除新增的店家 |
| `GET` | `/api/events` | SSE 事件串流，事件名 `store:update`、`additions:update` |
| `GET` | `/healthz` | 健康檢查 |

`PATCH /api/stores/:id` 的 `contactedAt` / `channel` / `owner` / `reply` 目前**在網頁上是隱藏的**
（卡片只留發送狀態），但 API 與資料結構都還在，要恢復顯示只需改 `public/app.js` 的 `storeCard()`。

## 更新名單

原始 Excel 有新增店家時：

```bash
python3 scripts/parse_xlsx.py && python3 scripts/build_form_xlsx.py
```

`data/stores.json`（名單）與 `status.json`（填寫紀錄）是分開的兩份檔案，用 `id`
（`分頁名-列號`）對應，所以重新匯入名單**不會蓋掉已經填好的聯繫紀錄**。但若在原始 Excel
的中間插入列，列號會位移、對應會跑掉——請一律在各分頁**最後面**新增。

## 已知限制

- 「待補名單」分頁的 76 筆手動新增店家，原始檔只有一行文字、沒有地址，因此無法歸入街道，
  在網站與 Excel 中都獨立列出，補齊地址後再併入主名單。
- 確認表單 Excel 的「街道總覽」用了 `SUM` 等公式；產生的檔案沒有預先算好的快取值，
  用 Excel／LibreOffice 開啟時會自動計算（本專案的建置環境無法執行 LibreOffice 重算）。
