# Widgets UI 模組

這個資料夾負責儀表板右側 Widgets 工具區。

Widgets 的基礎合約是物件導向：每一個工具都是 `DashboardWidget` 的子類別，尺寸只能使用標準 preset：`1x1`、`1x2`、`2x2`。其中 `1x2` 對應 Apple Widgets 的中型橫向版型，也就是一列兩欄。後續折線圖、圓餅圖、表格、地圖窗格快速跳轉與測速工具都應該沿用這個合約，不在頁面中零散拼 DOM。

Widget 的滑鼠行為由 `bindWidgetPointerBehavior` 共用函式接管：左鍵是主要動作，右鍵是設定。卡片上的左鍵會展開窗格，展開窗格上的左鍵會縮回 Widgets。所有 Widgets 區域共用 `WidgetPopoverController.shared()`，避免每個面板各自建立一套全域彈窗。

槽位由 `WidgetSocketLayout` 建立，只負責排版、拖曳落點與後續碰撞判斷；槽位本身不是前景 UI，正常狀態與拖曳狀態都必須維持不可視。

拖曳置放由面板層 `WidgetsPanel` 接管，不能綁在單一 slot DOM 上。面板會用滑鼠座標反算 slot，並透過 `canPlaceWidgetAt` 檢查尺寸、邊界與已占用槽位；不符合條件時不移動 Widget。

拖曳時只能顯示 `widget-drop-preview` 預覽框，用來描出目前 Widget 預計占據的矩形範圍；不可把所有 slot 常態畫出來。

設定入口使用 `WidgetCatalogItem` 生成 Widget 市集。市集產品卡只宣告工具種類、尺寸與預覽縮圖；拖曳到面板後由 `WidgetsPanel.addWidgetFromCatalog` 建立真正的 `DashboardWidget` 子類別實例，不能用 checkbox 清單直接把狀態硬寫進畫面。

每個 Widget 子類別負責自己的空白範本與視覺語意。卡片內是摘要視圖：`1x1` 只顯示大概趨勢或主形狀，`1x2` / `2x2` 顯示更多軸線、欄位或列表細節；左鍵展開時使用同一個子類別的完整視圖，未來再接真實資料或 Plotly。
