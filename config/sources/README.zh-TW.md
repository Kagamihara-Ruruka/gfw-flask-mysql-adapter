# Config Sources

`config/sources/` 的每一個子資料夾是一個資料源抽屜，不是 config 卡片。

控制頁的層級是：資料源抽屜或暫存區抽屜，底下放多張 config JSON 卡片。抽屜由資料夾枚舉與 `config/state/source_groups.local.json` 的 `id`、`ignore`、`created_at` 等狀態共同決定；config 卡片則對應實際 JSON 檔案。

`ignore=1` 表示抽屜不顯示。空資料夾會回報 `ignore=1`，但資料夾和狀態可以保留，之後有 JSON 被搬入時再恢復顯示。

檢視器的 group selector 採 `mv` 語意：group 是目標目錄，目錄不存在就建立，目錄已存在就直接作為目標。config 是被搬移的 JSON 檔；如果目標目錄已有同名 JSON，代表同一張 config 被外部更新，操作會覆蓋目標檔案。config 卡片需要顯示最後編輯時間，讓維護者判斷目前版本的新舊。

`managed/` 是歷史相容與隔離用目錄，預設可以被 registry 標成 `ignore=1`，不作為瀏覽器中的資料源抽屜顯示。
