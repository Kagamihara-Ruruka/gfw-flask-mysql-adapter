# Config Staging

`config/staging/` 是匯入 JSON config 的暫存區。

這裡的檔案是候選 config，會被 staging 狀態機掃描並注入開發者控制頁，但不會進入正式資料源路由，也不會連線 DATABASE、WEBSOCKET、SPATIAL 或 ENDPOINT 服務。

使用者選定資料源 group 後，系統會把候選檔 promote 到 `config/sources/<group>/`，成功後移除 staging 原件，避免同一份 config 同時存在兩個真相。
