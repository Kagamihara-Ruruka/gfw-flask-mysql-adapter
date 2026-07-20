# Sampled-grid 渲染正確性驗收（2026-07-20）

## 範圍

本輪以 Git `85072c3` 上的未提交工作樹驗收 P0 sampled-grid 渲染修正。範圍只包含 Canonical validity、Render transaction、SpatialValidityMask 接縫與操作競態；未加入 Brownian、新 UI 或相容 shim。

## 收斂後的唯一真相

```text
Provider status
→ Compiled Mapping status_semantics
→ Canonical observed / filled / no_data / unknown
→ Paint Policy
→ Renderer
```

- Mapping 擁有 provider status aliases 與 Canonical 正規化。
- `filled` 與 `observed` 在具有數值及合法 bounds 時可渲染；`coverage_ratio` 不得推翻 Canonical validity。
- Renderer 不辨識 `contains_filled`、`derived_with_fill` 或 `zero_filled` 等來源字串。
- Null、陸地與 Canonical `no_data` 才會透明。
- `actual_resolution` 只記錄收到的事實，不回流控制下一次 query resolution。

每次可見 commit 固定下列身份：

```text
frameKey / scopeKey / datasetId / date / BBOX
renderEpoch / RenderContext signature
maskId / maskVersion / maskRevision / maskScopeSignature
```

舊 epoch 的結果可以進入 LRU，但不得更新目前畫面。Crossfade、reveal 與 cleanup callback 由單一 transition generation 管理；失效 callback 不得操作被 pool 重用的 layer。

## 確定性測試

| 測試 | 結果 |
|---|---:|
| `node --test tests/*.test.mjs` | 294 / 294 通過 |
| `.venv\\Scripts\\python.exe -m unittest discover -s tests` | 121 / 121 通過 |
| 合計 | 415 / 415 通過 |

測試涵蓋 Canonical status 正規化、`filled + coverage_ratio=0`、provider status 禁止依賴、RenderContext／Mask identity、舊 epoch 淘汰、crossfade generation、mask single-flight、timeout、LRU、tile 邊界與 EEZ 關閉失效。

## 外部 Chrome 視覺風暴

以外部 Chrome 的新頁面與新 Browser Runtime 執行。五個 sampled-grid 資料集逐一啟用 EEZ，並交錯執行播放、1x／2x 切換、z6→z7、拖曳、單格選取、Widget、EEZ 關閉／重開及資料集切換。

| 資料集 | Alpha | 白色接縫 | 矩形／象限破圖 | 舊 Scope 覆寫 | 結果 |
|---|---:|---:|---:|---:|---|
| chlor_a | 0 | 0 | 0 | 0 | 通過 |
| fishing_hours | 0 | 0 | 0 | 0 | 通過 |
| ocean_productivity_score | 0 | 0 | 0 | 0 | 通過 |
| sea_temperature | 0 | 0 | 0 | 0 | 通過 |
| sustainability_pressure | 0 | 0 | 0 | 0 | 通過 |

瀏覽器 warning／error 為 0；抽查的 5085 batch 與 mask request 均為 HTTP 200。2x 加操作風暴時曾出現一次可恢復的 2.48 秒 buffer episode，之後 ready-ahead 回補至 34 張；沒有反覆 buffering、永久 `FETCHING` 或播放狀態卡死。

這是本輪 P0 視覺與互動驗收，不等同於重新完成五資料集全年冷快取基準。先前全年結果仍保留在 `runtime_truth_acceptance_2026-07-19.md`；本輪沒有以舊結果替代新程式的視覺驗收。

## 資料集身份檢查

以相同查詢條件抽查 transport payload，五個資料集的內容雜湊皆不同：

| 資料集 | Payload SHA 前 16 碼 |
|---|---|
| chlor_a | `5ad970f6a464502a` |
| fishing_hours | `5685d30e845748d6` |
| ocean_productivity_score | `4b096bbc0dd8225e` |
| sea_temperature | `a64fcf3e53c2c148` |
| sustainability_pressure | `153ddbd6207ec1ee` |

因此五個控制項沒有誤載同一份資料；視覺相似來自共用 AOI、格網與色彩表面策略，不是 dataset identity 碰撞。

## 冷快取說明

本輪啟動新的 5085 process、外部 Chrome 頁面與 Browser Runtime，因此 Browser `DataFrameStore`、Renderer pool、Mask image LRU 與 5085 process-local cache 都由空狀態開始。8791 process 未重啟，所以此處稱為「Browser／5085 冷快取」，不宣稱整條來源服務的物理冷啟動。

## 結論

五項 P0 異常在本輪驗收路徑中均未重現，且未觸發資料集名稱硬編碼、雙軌 Renderer、Canonical／API 語意變更等回滾條件。工作樹仍未建立 checkpoint；建立 checkpoint 前應保留本報告、完整測試結果與最後外部瀏覽器畫面。
