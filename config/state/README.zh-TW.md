# Config State

`config/state/` 保存控制頁產生的本地狀態 JSON。

這裡的檔案不是外部資料源，也不是 runtime config。`router_manifest.local.json` 記錄哪些 config 被啟用、鎖定或註記；`source_groups.local.json` 記錄資料源抽屜的 `id`、`ignore`、`created_at` 等 metadata。控制頁可以修改這些狀態，但資料源本體仍放在 `config/sources/<group>/`。
