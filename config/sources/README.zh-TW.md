# Config Sources

`config/sources/` 的每一個子資料夾是一個資料源抽屜，不是 config 卡片。

控制頁的層級是：資料源抽屜或暫存區抽屜，底下放多張 config JSON 卡片。抽屜由資料夾枚舉與 `config/state/source_groups.local.json` 的 `id`、`ignore`、`created_at` 等狀態共同決定；config 卡片則對應實際 JSON 檔案。

`ignore=1` 表示抽屜不顯示。空資料夾會回報 `ignore=1`，但資料夾和狀態可以保留，之後有 JSON 被搬入時再恢復顯示。

檢視器的 group selector 採 `mv` 語意：group 是目標目錄，目錄不存在就建立，目錄已存在就直接作為目標。config 是被搬移的 JSON 檔；如果目標目錄已有同名 JSON，代表同一張 config 被外部更新，操作會覆蓋目標檔案。config 卡片需要顯示最後編輯時間，讓維護者判斷目前版本的新舊。

`managed/` 是保留給匯入檔案隔離與刪除權限判定的內部目錄，預設由 registry 標成 `ignore=1`，不作為瀏覽器中的資料源抽屜，也不參與 runtime source discovery。

HTTP-backed DATABASE source 可以在自己的 `query_policy.max_in_flight` 宣告實體來源可同時承受的 operation 數量。這是後端 `QueryBatchExecutor` 解包 batch 後的 provider capacity，不是瀏覽器批次大小，也不是播放水位。未宣告時採保守值 `1`；應以相同日期集合的受控量測決定，不得直接照搬機器 CPU 數。

[`../examples/sources/database/pipeline-iceberg.example.json`](../examples/sources/database/pipeline-iceberg.example.json) 示範 HTTP Iceberg 來源與 `max_in_flight`。將範例複製到 `config/sources/database/` 後再填入實際 host、port、runtime launcher 與 secret；本機 source config 由 gitignore 排除，不得強制提交。
