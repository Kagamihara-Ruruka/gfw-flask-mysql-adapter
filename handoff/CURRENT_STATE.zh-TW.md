# 大可愛目前交接狀態

更新時間：2026-07-08

## 專案定位

本 repo 是「大可愛海事資料儀表板」MVP。主服務是消費端儀表板，開在 `5057`；開發者路由控制台是輔助入口，開在主服務 port + 1，也就是目前的 `5058`。

核心邊界：

- 儀表板只消費資料與渲染資料圖層。
- 上游爬蟲負責養資料庫，不應與儀表板進程綁死。
- config / route / schema / mapping / layer contract 正在逐步拆成可注入管線。
- WebSocket、DATABASE、SPATIAL 是不同合約類型，不要再混在同一個語意裡。

## 啟動方式

```powershell
python core.py serve --port 5057
```

`core.py` 目前會維持主服務與開發者服務的雙 port 流程，並保留 kill-port-if-busy 的開發期行為。

## 目前穩定功能

- 主儀表板：
  - GFW + EEZ 圖層顯示。
  - 單日資料與時間序列播放。
  - 播放快取、區間預熱、播放緩衝門檻。
  - 地圖 16:9 版面、BI 占位區、全螢幕浮動播放器。
  - 測速欄已改成甘特圖與 Plotly 快照耗時線圖。

- EEZ：
  - 目前以 PostGIS / spatial route 作為主要高效路徑。
  - EEZ 是持久圖層，快照更新時不應重複查詢；縮放變動才需要依 zoom / bbox 更新 LOD。
  - 對外部署時需要補齊自動下載 EEZ 公開資料與入庫流程，避免別台機器手動處理 PostGIS。

- GFW：
  - 動態資料流，時間序列播放會查詢不同快照。
  - 已有快取命中路徑；快取命中時 SQL 查詢應接近 0。
  - 未來應往區間一次查詢、本地切片、多核拆快照、GPU 背景烘焙方向優化。

- 開發者頁：
  - 位於 `http://127.0.0.1:5058/`，主頁籤中以 iframe 套入。
  - Config 瀏覽器已拆分 DATABASE / WEBSOCKET / SPATIAL / DEMO。
  - DEMO 不可啟用，也不進路由狀態機。
  - 路由狀態機與 WebSocket 狀態機分欄顯示。
  - Schema / Mapping 控制器雛形已建立，用於關聯式資料庫 schema 探測與欄位映射。

## 剛完成的優化

- 測速視覺化：
  - 移除上方純文字測速欄與舊的渲染就緒狀態機。
  - 甘特圖放到地圖下方，代表一張快照生命週期。
  - 持久圖層沒有參與本輪快照時不顯示，但比例仍可參考最近一次持久圖層耗時。
  - 新增互動延遲：使用者按下控制按鈕到第一次進入渲染呼叫的時間。
  - Plotly hover label 已改成深色模式。

- 播放器：
  - 播放前預熱改成具備 buffer 門檻的模型。
  - 不允許誰先完成就誰先播放，快照必須依時間順序。
  - 播放速度越快，越需要保留更多安全緩衝。

- Config / route：
  - manifest 逐步成為路由真相來源。
  - 舊合約與新合約要並存，避免上游或後端被迫一次切換。
  - Schema Inspector 是後端能力；Mapping Controller 是前後端共同能力；Layer Contract 是後端輸出給儀表板的圖層合約。

## 目前已知問題

- 4x 播放在全球尺度、無快取、查詢 9 萬列左右時仍可能出現 10 秒級 SQL 查詢。
- 快取命中後體驗良好，線圖大約落在 100 ms 級，但初次查詢仍是主要瓶頸。
- Plotly 線圖目前綁播放器 reset，但仍需繼續確認所有重播/跳轉情境都會正確清空。
- EEZ 在別台機器部署可能因 PostGIS / EEZ 入庫缺失而失敗。
- `handoff/README.zh-TW.md` 既有內容有 mojibake，建議之後用這份文件重建索引。

## 下一步建議

1. 先做 EEZ 自動依賴：
   - 啟動時檢查本地是否已有 EEZ `.gpkg` 或入庫結果。
   - 沒有就下載公開穩定資料源。
   - 再依 config 決定是否匯入 PostGIS。

2. 優化 GFW 查詢策略：
   - 播放前用區間查詢取代逐日查詢。
   - 只 select mapping controller 實際需要的欄位。
   - 在本地依日期切片為快照。
   - 快照切片可使用 pandas / pyarrow，但必須受快取容量上限約束。

3. 優化渲染策略：
   - CPU 多核拆快照。
   - GPU / WebGL 背景烘焙快照。
   - 播放、回到開始日期時先釋放既有 GPU 快取，再重新烘焙。

4. 完成關聯式資料動態注入：
   - 路由 config 只描述如何連線。
   - Schema Inspector 探測 table / columns。
   - Mapping Controller 讓使用者勾選欄位與指定 lat/lon/time/value。
   - Layer Contract 生成儀表板可渲染的資料圖層。

## 重要檔案

- `core.py`：主啟動入口。
- `Interface.py`：主 Flask API 與頁面路由。
- `DatabaseConnect.py`：資料庫連線與查詢入口。
- `DeveloperConfigService.py`：開發者 config / route 管理。
- `SchemaInspector.py`：關聯式 schema 探測。
- `LayerContractService.py`：圖層合約生成。
- `LayerRuntimeService.py`：runtime 圖層狀態。
- `LodOverlayService.py`：EEZ / overlay LOD。
- `static/TimingMetrics.js`：測速甘特圖與互動延遲。
- `static/js/ui/snapshot-performance-chart.js`：Plotly 快照耗時線圖。
- `static/js/services/playback-cache-service.js`：播放快取與預熱。
- `static/js/services/render-intent-service.js`：渲染意圖服務。
- `templates/index.html`：主儀表板。
- `templates/developer.html`：開發者路由控制台。

