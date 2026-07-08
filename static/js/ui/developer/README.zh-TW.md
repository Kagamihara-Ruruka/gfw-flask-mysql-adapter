# Developer UI 模組邊界

這個資料夾只放開發者頁面的前端控制物件。頁面語意由後端 config / route state / mapping 產物提供，前端不得在這裡硬編資料源分類或資料層合約。

## Config 路由器

- `developer-configs.js`：Config 路由器的 orchestration。負責串接 API、列表、右側編輯器、狀態機刷新，不直接持有 modal DOM 細節。
- `developer-config-list.js`：左側抽屜與 config card 物件。抽屜底下放卡片；抽屜 header 不放 config action。
- `developer-config-editor.js`：右側 JSON 檢視器與編輯態。只管理目前選取檔案、原始內容、儲存/取消按鈕與 group select 顯示狀態。
- `developer-config-note-modal.js`：Config 註記 modal。只管理註記視窗的開關與儲存。
- `developer-source-group-selector.js`：右側編輯區的 source group 下拉選單與「新增新群組」modal。群組來源來自後端枚舉的 source drawers。
- `developer-import.js`：匯入與 staging dropzone。
- `developer-wizard.js`：Config 引導精靈。

## 狀態與 Mapping

- `developer-status-table.js`：狀態表格的通用表格物件。
- `developer-status-machines.js`：路由狀態機、Schema profile、資料圖層導入的載入與刷新。
- `developer-mapping-controller.js`：Schema / Mapping 控制器。接收狀態機探測結果，產生 mapping 產物。

## 共用工具

- `developer-api.js`：開發者頁 API client。
- `developer-utils.js`：DOM、訊息、badge、字串 escaping 等小工具。
