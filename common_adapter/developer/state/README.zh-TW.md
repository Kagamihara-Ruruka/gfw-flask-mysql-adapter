# Developer State

這個資料夾只放開發者頁面需要長期保留的狀態，例如 router manifest 與已導入圖層清單。

這類資料像瀏覽器 cookie：它是使用者操作後留下的狀態，不是外部資料源，也不是 mapping 合約本體。程式不能把它顯示成資料源，也不應自動清除。

`manifest.py` 的主物件是 `RouterManifestStore`，負責 `config/state/router_manifest.local.json` 的讀寫與正規化。模組層函式是同一 store 的公開 API，不是另一套相容狀態或第二份真相。
