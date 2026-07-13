# 地圖互動模組

這個資料夾只負責地圖表面的控制器與互動狀態，不負責資料查詢或 Widget 呈現。地圖控制器將結果寫入共用狀態並發送事件，查詢能力再依事件注入自己的資料流。

`tile-selection-layer.js` 將網格命中、連續模式抽屜與選取集合分成 `GfwCellHitTester`、`ContinuousTileSelectionDrawer`、`TileSelectionLayer` 三個物件。模式定義集中在 `TileSelectionModeRegistry`，不可在各個 Widget 內重複判斷模式名稱。

單點與連續操作從地圖工具列入口便分離。既有 `scan-line` 入口只切換 `multiple=false` 的單點模式，不開啟設定窗；連續入口只負責開關 `ContinuousTileSelectionDrawer`。連續抽屜由 `multiple=true` 的模式動態生成，並擁有啟用開關與清除所有已儲存標籤的操作。底層只允許一個模式作用，`enabled=false` 表示兩個入口都未啟用。

`state.tileSelection.selected` 是相容既有單點工具的目前作用項；`state.tileSelection.items` 才是依選取順序保存的完整集合。關閉選取模式或執行「清除所有儲存 Tile 標籤」都會清空集合，切換模式則保留可相容的空間選取。

`ensureState()` 只建立與校正 state 結構，不得反向覆蓋控制器正在執行的模式；模式改變後由 `emitChange()` 單向寫回 state。這條界線避免切換 UI 已更新、第一次地圖事件卻退回舊模式。

單點模式與同時異地模式使用 `live_player`，查詢時間跟隨目前播放器。異時異地模式使用 `locked_axis`，每一項保存選取當下的 `{start, end, cursor}`；其識別值由 `tile_key` 與時間軸雜湊共同組成，允許同一 Tile 在不同時間軸各自存在。

複選方框中央的編號就是 `items` 的一基底順序，並與 EEZ 展開視圖的 `Tile 1、Tile 2…` 對應。`SameTimeLocationLabel` 與 `LockedTimeLocationLabel` 是兩個獨立物件：前者呈現圓形位置編號，後者呈現鎖定樣式編號。兩者不在地圖顯示日期；完整時間軸只保存在選取資料與展開結果中。同一空間 Tile 若保存了多個時間軸，鎖定標籤會合併列出其編號，避免標籤重疊。

所有下游功能只監聽 `rrkal:tile-selection-changed`。事件內容包含 `mode`、目前 `selected` 與完整 `items`，避免 Widget 反向讀取地圖 DOM。
