# Developer Probes

這個資料夾只放狀態探測 adapter。

Probe 負責回答「這個資料源目前能不能用、能不能探測 schema、依賴表是否 ready」。它不負責保存使用者決策，也不負責產生 mapping 合約。

目前 `status.py` 的主物件是 `RouteProbe`，包含 database 與 spatial route 的探測邏輯。舊函式入口仍保留，但應視為 facade。

未來新增資料源種類時，應優先新增對應 probe，而不是在 UI 寫死判斷。
