# Runtime OOP 收斂

本文件記錄第二輪重構前後的狀態所有權、依賴方向與後續建模規則。此輪只收斂 Runtime 物件與組裝責任，不改 UI 行為、外部 API、Canonical Frame、快取語意、查詢語意或 Renderer 合約。

## 重構前依賴圖

```mermaid
flowchart LR
  UI["Playback controls / Map / Widgets"] --> PE["PlaybackEngine singleton"]
  UI --> FDS["FrameDemandService IIFE"]
  PE --> PP["PlaybackPreheater singleton"]
  PE --> DFS["DataFrameStore IIFE"]
  PE --> LE["LifecycleEventLog IIFE"]
  PP --> FDS
  PP --> DFS
  FDS --> LQC["LayerQueryCoordinator IIFE"]
  FDS --> DFS
  LQC --> QS["QueryScheduler instance"]
  QS --> LE
  FDS --> LE
  DFS --> LE
  UI --> PR["PlaybackRenderer IIFE"]
  UI --> TS["TileSelectionLayer self-created instance"]
  UI --> WP["WidgetsPanel self-created instances"]
  WP --> WR["Widget Registry factories"]
```

主要問題不是功能缺失，而是建立責任分散：類別在各自檔案底部自行 `new`，constructor 以全域名稱尋找依賴；部分具有可變狀態與生命週期的角色仍藏在 IIFE。這使依賴圖只能靠 script 載入順序成立，測試也容易無意間使用 Service Locator。

## 重構前狀態所有權

| 狀態／資源 | 目前 owner | 問題 | 本輪目標 owner |
| --- | --- | --- | --- |
| 播放日期、狀態、buffer、target demand | `PlaybackEngineCore` singleton | 自行尋找 Store、Preheater、Demand、EventLog | DI 建立的 `PlaybackEngine` instance |
| 預熱 scope、inflight、retry timer、Store subscription | `PlaybackPreheaterController` singleton | 自行尋找依賴並直接寫入全域 state | DI 建立的 `PlaybackPreheater` instance |
| query queue、active task、consumer、優先權 | `QueryScheduler`，藏在 Coordinator IIFE | instance 建立與 policy/state sink 隱藏 | DI 建立的 `QueryScheduler` instance |
| Canonical frame、alias、pin、failure、LRU | `DataFrameStore` IIFE closure | 有身份與資源，但不是可管理生命週期的物件 | DI 建立的 `DataFrameStore` instance |
| lifecycle events、run、listener | `LifecycleEventLog` IIFE closure | 有容量與 run lifecycle，但不是明確物件 | DI 建立的 `LifecycleEventLog` instance |
| HTTP demand orchestration | `FrameDemandService` IIFE | 無可變狀態，卻以全域取得所有依賴 | DI 呼叫的 stateless Application Service factory |
| active playback date 與日期事件 | `PlaybackRenderer` IIFE closure | active date owner 隱藏 | DI 建立的 `PlaybackRenderer` instance |
| 選取 mode、selected cells、time binding | `TileSelectionLayer` | session 狀態與 Leaflet/UI resource 混在同一 owner | `SelectionSession` 擁有狀態；Layer 只擁有視覺資源 |
| Widget instances 與位置 | `WidgetsPanel.widgets` | Panel 自行建構預設 instance；Popover 使用 static singleton | Panel 保持 collection owner，instance 只經 Registry factory 建立，Runtime root 注入 factory/popover |
| WebGL canvas、program、buffer、hit cells | `SampledGridWebglLayer` | 已有 `onAdd/onRemove`，owner 清楚 | 保留；只補齊組裝與銷毀責任文件 |

## 本輪依賴方向

```mermaid
flowchart LR
  CFG["Config / runtime state adapters"] --> ROOT["RuntimeCompositionRoot"]
  REG["Registry + capability matrix"] --> ROOT
  ROOT --> LE["LifecycleEventLog"]
  ROOT --> QS["QueryScheduler"]
  ROOT --> DFS["DataFrameStore"]
  ROOT --> FDS["FrameDemand Application Service"]
  ROOT --> PP["PlaybackPreheater"]
  ROOT --> PE["PlaybackEngine"]
  ROOT --> PR["PlaybackRenderer"]
  ROOT --> SS["SelectionSession"]
  ROOT --> WF["Widget Registry factory"]
  QS --> LE
  DFS --> LE
  FDS --> QS
  FDS --> DFS
  FDS --> LE
  PP --> FDS
  PP --> DFS
  PE --> PP
  PE --> FDS
  PE --> DFS
  PE --> LE
  UI["Existing UI call sites"] --> PE
  UI --> PR
  UI --> DFS
```

## 完成後狀態所有權

| Runtime 角色 | 唯一 owner | 建立位置 | 生命週期／銷毀責任 |
| --- | --- | --- | --- |
| 播放狀態、日期、target、buffer | `PlaybackEngine` | `RuntimeCompositionRoot` | `start / pause / stop / dispose`；停止時取消 target demand 並解除 frame pin |
| 預熱 scope、inflight、retry timer | `PlaybackPreheater` | `RuntimeCompositionRoot` | `setScope / stop / dispose`；銷毀時取消 scope、timer 與 Store subscription |
| query queue、active task、consumer | `QueryScheduler` | `RuntimeCompositionRoot` | `demand / cancelScope / dispose`；銷毀時 abort 未完成 task |
| Canonical frame、alias、pin、failure、LRU | `DataFrameStore` | `RuntimeCompositionRoot` | `put / inspect / pin / release / dispose`；銷毀時清空 RAM 與 listener |
| lifecycle event、run、listener | `LifecycleEventLog` | `RuntimeCompositionRoot` | `beginRun / record / endRun / dispose`；銷毀時清空 bounded log 與 subscription |
| 播放日期到既有 renderer 的 handoff | `PlaybackRenderer` | `RuntimeCompositionRoot` | 頁面期存活；`dispose` 清除 active date，不擁有 WebGL resource |
| WebGL/Canvas map resource | Leaflet layer instance | `RendererRegistry` 決策、map layer factory 建立 | Leaflet `onAdd / onRemove`；WebGL `onRemove` 釋放 program、buffer 與 canvas |
| 虛擬網格 strategy、revision 與 map/event subscription | `VirtualGridController` | `RuntimeCompositionRoot` | `bind / dispose` 對稱註冊與解除事件 |
| 選取模式、selected cells、time binding | `SelectionSession` | `TileSelectionLayer` aggregate factory，由 `AppRuntime.install` 接管 | Session 管資料；Layer 的 `dispose` 清除 Leaflet rectangle、label、cursor 與 listener |
| coverage viewport bounds | `LayerViewportController` | `RuntimeCompositionRoot` | 擁有 map min zoom/max bounds；`dispose` 還原 map 約束 |
| Render intent 組裝 | 無可變狀態 | `RuntimeCompositionRoot` 建立 `RenderIntentService` factory | 只讀注入的 state、viewport、FrameIdentity 與日期 provider；不自行定位全域依賴 |
| 圖層啟用 transition queue | `LayerActivationController` | `AppRuntime.install` | 序列化 transition；`dispose` 關閉後續 command |
| Widget panel、popover、全域事件 subscription | `WidgetRuntimeController` | `AppRuntime.install` | `mount / dispose`；AbortSignal、map listener、panel、popover 對稱釋放 |
| Widget instance collection、slot placement | 各 `WidgetsPanel` | `WidgetRuntimeController` | Widget 只能由 `WidgetRegistry` factory 建立；替換、刪除與 panel dispose 均呼叫 instance `dispose` |

`RuntimeCompositionRoot.snapshot()` 只暴露 owner 名稱與組裝狀態供測試／診斷，不建立第二份 Runtime 狀態。全域名稱是既有 call site 的唯讀 reference；真正的建立與 teardown 仍只有 composition root 一條路徑。

## Class 判定規則

符合任一條件才使用 class：跨呼叫保存可變狀態；具有建立、啟動、停止或銷毀階段；可同時存在多個獨立實例；必須阻止非法狀態轉換；擁有 Runtime 資源。

以下維持 pure function：Frame key／intent key、BBOX 計算、Mapping、Canonical normalization、色彩與 ViewModel 建構。Registry 與能力矩陣仍是能力與相容關係的唯一真相，不以 inheritance 取代。

所有 Runtime class 由 `RuntimeCompositionRoot` 建立並注入依賴。Class 不讀全域 Config、不自行 `new` service；Decorator 及事件 subscriber 只處理 logging、metrics、tracing，不改變核心語意。

## 追加設計約束

本輪建立後續模組的物件建模規則，但不提前擴張至 UI／業務分離：

1. 有身份、可變狀態、生命週期或不變量的角色使用 class。
2. 純計算、Mapping、正規化與 ViewModel 建構維持 pure function。
3. Registry 與能力矩陣仍是能力及相容關係的唯一真相，不得被 class inheritance 取代。
4. 所有 class 必須由 DI composition root 建立，不得自行尋找或建立 service dependency；建立自身 timer、AbortController、DOM 或 GPU resource 不視為 service lookup，但必須自行釋放。
5. Decorator 僅處理 logging、metrics、tracing 等橫切能力，不得改變核心語意。
6. 本文件是狀態所有權表與 class 判定規則的唯一說明；stateless Application Service 使用 [`application-service.template.js`](application-service.template.js) 的 factory 形式。
7. 後續 UI／業務分離新增的程式必須直接遵守上述規則，不得完成後再二次 OOP 化。
8. 本輪不修改 UI 行為、不抽離 Widget 業務邏輯、不擴張既定驗收範圍。

## 維持 Pure Function／Factory 的角色

- `FrameIdentity`、BBOX／coverage 計算、watermark/date window、color domain、Mapping 與 Canonical normalization 是 pure function 或 immutable registry。
- `FrameDemandService`、`PlaybackCacheService` 與 `RenderIntentService` 沒有跨呼叫私有狀態，因此使用注入依賴的 stateless factory，不為形式一致而 class 化。
- `PlaybackScheduler`、`PlaybackFrameBuffer`、`PlaybackDeliveryPolicy` 與 interpolation policy 是純 policy／計算物件，不擁有播放生命週期。
- `RendererRegistry`、`WidgetAbilityRegistry`、`WidgetSizeAbleDict` 與 Mapping registry 仍負責決策；Runtime class 只接收決策結果或 registry interface。

## Widget UI／Application 邊界

Checkpoint B 已移除圖表 DataSource 的 `shared()` 與 UI service lookup。`RuntimeCompositionRoot` 建立唯一的 `WidgetApplicationRuntime`，其中的 `WidgetQueryContext` 統一解讀目前日期、啟用圖層、Tile 選取、BBOX、LOD 與 canonical frame key；各 DataSource 擁有自己的 cache、inflight 與生命週期。Registry factory 在建立 Widget instance 時注入 frozen `services`，Capability 只負責 View、ViewModel 與使用者命令。

```mermaid
flowchart LR
  ROOT["RuntimeCompositionRoot"] --> WAR["WidgetApplicationRuntime"]
  ROOT --> REG["WidgetAbilityRegistry"]
  WAR --> WQC["WidgetQueryContext"]
  WAR --> DS["Widget DataSources"]
  DS --> DFS["DataFrameStore"]
  DS --> FDS["FrameDemandService"]
  REG --> FACTORY["Widget factory"]
  WAR --> FACTORY
  FACTORY --> WIDGET["Widget View / ViewModel"]
```

邊界規則：

- Widget、View 與 Launchpad 不得直接取得 Store、Demand、Coordinator 或 Config。
- 表格與事件檢視器只讀既有 Runtime 狀態，不會在 cache miss 時補查。
- 折線圖、圓餅圖與橫條圖只透過注入的 Application DataSource 取資料；允許補查時也只能提交 widget lane demand。
- Application service 不建立 DOM；Capability 不擁有 query cache。
- DataSource 的建立與銷毀集中在 composition root，不保留 `.shared()`、wrapper 或雙軌 shim。

## 停止條件

若任何遷移必須改動 UI 行為、外部 API、資料格式、Canonical Frame、查詢／快取語意或 Renderer 合約，停止該遷移並另立功能派工。本輪不提前抽離 Widget 業務邏輯。
