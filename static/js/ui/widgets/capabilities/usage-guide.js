(() => {
const {
  DashboardWidget,
} = window.WidgetCore;

const UsageGuideSections = Object.freeze([
  Object.freeze({
    id: "quick-start",
    label: "快速開始",
    icon: "rocket",
    title: "從一個資料圖層開始",
    lead: "先決定要看的資料，再決定日期與空間範圍；未啟用的圖層不會查詢或渲染。",
    steps: Object.freeze([
      Object.freeze({ title: "啟用圖層", detail: "打開「資料圖層」抽屜並勾選一個主圖層。EEZ 是可獨立開關的向量疊圖。" }),
      Object.freeze({ title: "選擇日期", detail: "單日查詢可直接選日期，或使用「最後一日」跳到資料集最新快照。" }),
      Object.freeze({ title: "調整視角", detail: "縮放或拖曳地圖後，系統只補齊目前視角與圖層 coverage 交集所需的資料。" }),
      Object.freeze({ title: "檢閱結果", detail: "使用選格工具指定 Tile，再開啟圖表、表格或海域管轄判定 Widget。" }),
    ]),
  }),
  Object.freeze({
    id: "layers-map",
    label: "圖層與地圖",
    icon: "layers-3",
    title: "控制資料與顯示方式",
    lead: "圖層抽屜擁有啟用與順序；齒輪只暴露該圖層合約真正支援的設定。",
    steps: Object.freeze([
      Object.freeze({ title: "啟用與排序", detail: "勾選代表啟用；拖曳圖層可調整疊放順序。所有主圖層都可關閉。" }),
      Object.freeze({ title: "圖層齒輪", detail: "依圖層能力調整 metric、解析度倍率、色彩、透明度與顯示模式。沒有能力的選項不會出現。" }),
      Object.freeze({ title: "地圖齒輪", detail: "切換底圖、經緯網格、比例尺、Renderer 與其他全圖層顯示偏好。" }),
      Object.freeze({ title: "全螢幕", detail: "右側全螢幕按鈕會保留時間播放控制；離開全螢幕後仍延續同一個播放狀態。" }),
    ]),
  }),
  Object.freeze({
    id: "playback",
    label: "時間播放",
    icon: "circle-play",
    title: "依序播放真實快照",
    lead: "設定起訖日期後播放，每一張 snapshot 都依序呈現；倍率只改變時間軸節拍。",
    steps: Object.freeze([
      Object.freeze({ title: "設定範圍", detail: "選擇開始與結束日期，再用 replay、前一日、播放與後一日控制時間線。" }),
      Object.freeze({ title: "選擇倍率", detail: "可選 0.5x、1x、2x 或 4x。倍率不會改寫 HTTP timeout 或真實等待時間。" }),
      Object.freeze({ title: "辨識狀態", detail: "PREPARING 是冷啟動準備；BUFFERING 表示當下目標尚未就緒；FETCHING 可與播放同時進行。" }),
      Object.freeze({ title: "背景補水", detail: "預熱器會獨立維持 ready-ahead 水位。暫停播放不會把已完成的快取清除。" }),
    ]),
  }),
  Object.freeze({
    id: "selection-widgets",
    label: "選格與 Widget",
    icon: "layout-dashboard",
    title: "用 Tile 串起地圖與工具",
    lead: "單點選格是即時查詢入口；Widget 優先讀取地圖已建立的 Canonical 快取。",
    steps: Object.freeze([
      Object.freeze({ title: "單點選格", detail: "按下單點網格按鈕後，在可選取的虛擬網格內點擊一格；再次選取會更新目前焦點。" }),
      Object.freeze({ title: "連續選格", detail: "連續模式使用獨立入口與設定，可保存多個 Tile 供比較，不會與單點模式同時開啟。" }),
      Object.freeze({ title: "開啟工具", detail: "短按 Launchpad 圖示會暫時展開工具；拖曳到右側槽位才會建立儀表板 Widget。" }),
      Object.freeze({ title: "檢閱快取", detail: "表格顯示目前日期與視角已有的快取；圖表與海域判定會跟隨目前日期或選取 Tile。" }),
    ]),
  }),
  Object.freeze({
    id: "settings-developer",
    label: "設定與開發者",
    icon: "settings-2",
    title: "調整 Runtime，檢查資料註冊",
    lead: "一般操作放在設定頁；資料來源、Probe、Mapping 與 Runtime 註冊真相放在開發者頁。",
    steps: Object.freeze([
      Object.freeze({ title: "設定頁", detail: "調整 Renderer、快取 RAM、水位策略、Frame 補間與視覺偏好。沒有控制項的觀測資料留在儀表板 Widget。" }),
      Object.freeze({ title: "開發者頁", detail: "檢查來源 Config、路由狀態、Probe／Scout 結果、Mapping Schema 與已註冊圖層。" }),
      Object.freeze({ title: "能力狀態", detail: "不可用的來源或能力應顯示原因；勾選但註冊失敗時不會偷偷建立空白 Runtime 圖層。" }),
      Object.freeze({ title: "事件檢視器", detail: "需要排查播放、Query 或快取時，使用生命週期事件檢視器查看同一 run 的完整事件鏈。" }),
    ]),
  }),
]);

class UsageGuideWidget extends DashboardWidget {
  constructor(options) {
    super(options);
    this.activeSectionId = UsageGuideSections[0].id;
  }

  activeSection() {
    return UsageGuideSections.find((section) => section.id === this.activeSectionId)
      || UsageGuideSections[0];
  }

  renderIcons(container) {
    window.lucide?.createIcons?.({
      attrs: { "stroke-width": 1.8 },
      nodes: container.querySelectorAll("[data-lucide]"),
    });
  }

  renderCompact(container) {
    container.innerHTML = `
      <div class="usage-guide-compact">
        <i data-lucide="book-open-text" aria-hidden="true"></i>
        <span>開啟指南</span>
      </div>
    `;
  }

  renderExpandedContent(container) {
    const section = this.activeSection();
    container.innerHTML = `
      <div class="usage-guide-layout" data-widget-interactive>
        <nav class="usage-guide-nav" aria-label="使用說明章節">
          ${UsageGuideSections.map((item) => `
            <button
              class="usage-guide-nav-button${item.id === section.id ? " is-active" : ""}"
              type="button"
              data-guide-section="${item.id}"
              aria-current="${item.id === section.id ? "page" : "false"}"
            >
              <i data-lucide="${item.icon}" aria-hidden="true"></i>
              <span>${item.label}</span>
            </button>
          `).join("")}
        </nav>
        <article class="usage-guide-content" aria-live="polite">
          <div class="usage-guide-heading">
            <span>${section.label}</span>
            <h4>${section.title}</h4>
            <p>${section.lead}</p>
          </div>
          <ol class="usage-guide-steps">
            ${section.steps.map((step, index) => `
              <li>
                <span class="usage-guide-step-number">${index + 1}</span>
                <div>
                  <strong>${step.title}</strong>
                  <p>${step.detail}</p>
                </div>
              </li>
            `).join("")}
          </ol>
        </article>
      </div>
    `;
    container.querySelectorAll("[data-guide-section]").forEach((button) => {
      bindWidgetActionButton(button, () => {
        this.activeSectionId = button.dataset.guideSection;
        this.renderTemplate(container, { expanded: true });
      });
    });
  }

  renderTemplate(container, { expanded = false } = {}) {
    container.classList.add("widget-template", "widget-template-usage-guide");
    container.classList.toggle("is-expanded", expanded);
    if (expanded) this.renderExpandedContent(container);
    else this.renderCompact(container);
    this.renderIcons(container);
  }

  renderExpanded() {
    const pane = super.renderExpanded();
    pane.classList.add("usage-guide-popover");
    this.renderIcons(pane);
    return pane;
  }
}

Object.assign(window.WidgetCapabilities ||= {}, {
  UsageGuideSections,
  UsageGuideWidget,
});
})();
