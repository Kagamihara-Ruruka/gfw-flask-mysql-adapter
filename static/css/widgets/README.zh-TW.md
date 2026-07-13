# Widgets CSS

Widgets 樣式依照 JavaScript 的責任邊界拆分為 `core/`、`capabilities/` 與 `runtime/`。模板中的 `<link>` 順序就是 cascade 順序，不可任意排序。

通用頁面、地圖、播放器與圖層樣式仍由 `static/styles.css` 管理；Widgets CSS 不得加入這些領域的 selector。
