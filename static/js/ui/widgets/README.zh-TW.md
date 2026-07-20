# Widgets UI 模組

這個資料夾負責儀表板右側 Widgets 工具區。

## 資料夾邊界

- `core/`：尺寸、基礎 Widget class、共用滑鼠行為與槽位配置；不認識任何具體能力。
- `capabilities/`：每種 Widget 能力自己的 View、ViewModel 轉換與 Widget class；不能查詢 server、讀取 Runtime service locator 或初始化頁面。
- `registry/`：宣告能力 class、metadata 與尺寸相容性，並負責建立 Widget 實例。
- `runtime/`：組裝面板、Popover、預設排版與全域事件生命週期。
- `../../application/widgets/`：Widget 查詢情境、cache-backed DataSource 與 Application Runtime；由 composition root 注入 UI。

依賴只能由 `application -> core -> capabilities -> registry -> runtime` 單向前進。UI 不得反向取得 `DataFrameStore`、`FrameDemandService` 或 `LayerQueryCoordinator`；`widget-launchpad.js` 位於 runtime 完成之後，透過公開 registry 與 panel API 操作，不反向讀取能力內部狀態。

Widgets 的基礎合約是物件導向：每一個工具都是 `DashboardWidget` 的子類別，尺寸只能使用標準 preset：`1x1`、`1x2`、`1x3`、`2x2`、`2x3`。尺寸採「列 x 欄」語意，例如 `1x3` 是一列三欄。折線圖、圓餅圖、橫條圖、表格、窗格跳轉、測速、海域管轄判定、使用說明與 BGM 工具都沿用這個合約，不在頁面中零散拼 DOM。使用說明固定註冊為 `1x1` 靜態能力，只整理目前 README 的有效操作語意，不建立 Query、Cache 或 Runtime 資料依賴。BGM 彩蛋同樣固定為 `1x1`；收合狀態只載入目前曲目的 Spotify oEmbed 專輯縮圖並保留底部聲紋，不建立播放器 iframe。第一階載入目前曲目的 Spotify 官方 Embed，第二階 16:9 視圖才附加播放清單，階段轉換保留同一個 iframe。曲目可用拖曳或鍵盤方向鍵排序，順序透過 Application Runtime 寫入 Browser profile；Widget 本身不直接存取瀏覽器儲存。它不接觸地圖 Query、Cache 或 Playback。折線圖的 MA5／MA10 是快取快照上的純 ViewModel 計算，只改變 Plotly trace；缺值不補零、不跨缺口，也不建立新的 Query 或快取身份。

Widget 的滑鼠行為由 `bindWidgetPointerBehavior` 共用函式接管：左鍵是主要動作，右鍵是設定。卡片上的左鍵會展開詳細窗格，再次點擊窗格會切換成 16:9 視圖，再點擊一次才關閉；`Esc` 也會關閉。`WidgetRuntimeController` 由 `AppRuntime` 建立，並把同一個 `WidgetPopoverController` 注入所有 Widgets 面板；不使用 static singleton。

槽位由 `WidgetSocketLayout` 建立，只負責排版、拖曳落點與後續碰撞判斷；槽位本身不是前景 UI，正常狀態與拖曳狀態都必須維持不可視。

拖曳置放由面板層 `WidgetsPanel` 接管，不能綁在單一 slot DOM 上。面板會用滑鼠座標反算 slot，並透過 `canPlaceWidgetAt` 檢查尺寸、邊界與已占用槽位；不符合條件時不移動 Widget。

拖曳時只能顯示 `widget-drop-preview` 預覽框，用來描出目前 Widget 預計占據的矩形範圍；不可把所有 slot 常態畫出來。

能力 metadata 與 class 由 `WidgetAbilityRegistry` 統一註冊，尺寸相容性由 `WidgetSizeAbleDict` 宣告。`WidgetLaunchpad` 是註冊能力與空白版型的可見入口；它只引用 `WidgetCatalogItem`，拖曳到面板後仍由 `WidgetsPanel.addWidgetFromCatalog` 建立真正的 `DashboardWidget` 子類別實例。Launchpad 中的 App 不會因建立或刪除 Widget 實例而消失。

`TableWidget` 是目前快照的唯讀 canonical cache 檢閱器。Application 層的 `TableWidgetDataSource` 依目前已啟用且已完成快取的圖層動態建立分頁，不合併不同圖層的資料列，也不向 server 發送查詢。未選取 Tile 時顯示目前地圖 snapshot 的快取；選取 Tile 後只檢閱該 bbox 對應的 canonical packet。cache miss 必須明確顯示尚無快照，不能由表格自行補查。UI 實作位於 `capabilities/table.js`，資料責任位於 `../../application/widgets/table-widget-data-source.js`。

Launchpad 由 `WidgetLaunchpad`、`AbilityPage`、`AbilityAppIcon` 三層物件組成。版型唯一真相是 `WidgetLaunchpadLayout`：每頁 12 欄、3 列、容量 36。每個頁面使用相同比例矩陣，位置保存為 `{page, row, column}`；版面寬度、欄位與翻頁位移使用比例，不以固定像素計算。超過容量時自動建立下一頁，頁面圓點、水平手勢與拖曳邊緣共同控制翻頁。

短按 `AbilityAppIcon` 會建立暫態 Widget 物件並呼叫與槽位 Widget 相同的 `handlePrimaryAction()`，因此共用展開、16:9 與關閉流程；拖曳超過門檻時會抑制短按事件。暫態物件不加入槽位集合，只有完成拖放才會建立目前頁面工作階段中的 Widget 實例。

每個 Widget 子類別負責自己的空白範本與視覺語意。卡片內是摘要視圖；高度一列的圖表使用輕量 SVG，高度二列或展開後的完整圖表使用 Plotly。Widget 只呼叫注入的 Application service；Application DataSource 必須先讀 `DataFrameStore`。播放期間的日期刷新只能消費既有快取；明確的 Tile 互動 miss 最多以 `widget-interactive` 補當日一張，閒置或暫停中的圖表才可用 `widget-auto` 補設定區間，且都不能直接呼叫 source API。表格與生命週期事件檢視器是嚴格唯讀工具，cache miss 也不能補查。資料查詢合約與視覺範本分離，未定義資料來源時只呈現明確的等待綁定狀態。

`LifecycleEventViewerWidget` 消費 `LifecycleEventLog`，提供 Run、資料集與事件類型篩選、JSON 匯出，以及 Queue、HTTP、cache commit、render、停頓與 cadence P95。它不接觸 `FrameDemandService`，因此不會因檢閱事件而改變被觀測的排程。

海域管轄判定能力會消費 `state.tileSelection.items` 的有序集合並查詢所有已保存 Tile。`1x1` 摘要固定顯示第一項；展開視圖保留第一項的完整管轄明細，再列出其餘異地結果。Widget 不自行建立或修改選取集合。
