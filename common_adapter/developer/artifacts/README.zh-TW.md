# Developer Artifacts

這個資料夾只放由控制器產生、可被 runtime 消費的內部產物。

Mapping 是內部協議，不是資料源。它由 Schema / Mapping Controller 根據 inspector 結果與使用者勾選生成，再寫入 `config/artifacts/layer_mappings.local.json`。資料圖層導入與 query request 會消費這些 mapping 產物。

Sampled-grid Mapping 除了欄位角色，也可以保存解析度、coverage 與 `default_coverage_id`。Runtime 只能消費這份宣告，不能從資料集名稱或最大的 AOI 猜測初始查詢範圍。

`layer_mappings.py` 的主物件是 `LayerMappingStore`，負責 mapping 的正規化、儲存、啟用與更新。模組層函式是同一 store 的公開 API，不是相容 mapping 或第二份真相。
