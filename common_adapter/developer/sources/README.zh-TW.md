# Developer Sources

這個資料夾只處理「外部資料源 config 檔案」與它們在開發者控制頁的瀏覽狀態。

邊界分工：

- `configs.py`：保留既有 facade 與 config JSON 的檔案操作入口，包含摘要、啟用、鎖定、註記、搬移、匯入與暫存流程。
- `drawers.py`：只管理 `config/sources/<group>/` 對應的資料源抽屜 registry，包含 `id`、排序、`ignore`、空資料夾狀態與 group selector options。
- `files.py`：只管理已落地於 `config/sources/<group>/` 的正式資料源 config 檔案，包含摘要、搬移、刪除、鎖定、註記與 JSON 寫回。
- `groups.py`：只管理 config 與 source group 的名稱正規化、內建 probe group 判斷，以及從檔案路徑或 JSON 內容推斷 adapter group。
- `staging.py`：只管理 `config/staging/` 暫存區狀態機，包含暫存檔掃描、候選 group、正式導入與暫存刪除。

UI 層級必須維持為：資料源抽屜或暫存區抽屜，底下放 config JSON 卡片。抽屜不是 config 卡片，也不承擔 config 卡片的按鈕動作。

後續若要新增來源類型，優先新增資料夾與 config 宣告，不要在前端硬編資料源分類。
