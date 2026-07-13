# Widget Registry

此資料夾是能力 class 與使用者可見 metadata 的唯一組裝點。`WidgetAbilityRegistry`、`WidgetSizeAbleDict` 與建立工廠共同決定某個版型能套用哪些能力。

Registry 不查資料、不渲染頁面，也不監聽事件；它只回傳正確的 Widget 物件。
