(() => {
const {
  DashboardWidget,
  bindWidgetActionButton,
} = window.WidgetCore;

const SpotifyAccountLoginUrl = "https://accounts.spotify.com/login";

const SpotifyEasterEggItems = Object.freeze([
  Object.freeze({
    kind: "track",
    id: "43b6I3gZnUiVxNBUeq9FsL",
    label: "Wish me luck!!!! - instrumental",
    sourceUrl: "https://open.spotify.com/track/43b6I3gZnUiVxNBUeq9FsL",
    thumbnailUrl: "https://image-cdn-fa.spotifycdn.com/image/ab67616d00001e029860affa2992c936f3d9552f",
  }),
  Object.freeze({
    kind: "track",
    id: "348NF6vX0Yh22xvH0EZEro",
    label: "NIGHT DANCER",
    sourceUrl: "https://open.spotify.com/track/348NF6vX0Yh22xvH0EZEro",
    thumbnailUrl: "https://image-cdn-ak.spotifycdn.com/image/ab67616d00001e02e2a3788f1a9dea9028099d4e",
  }),
  Object.freeze({
    kind: "track",
    id: "2ZT6eELxeETGamaiXu6vmk",
    label: "more than words",
    sourceUrl: "https://open.spotify.com/track/2ZT6eELxeETGamaiXu6vmk",
    thumbnailUrl: "https://image-cdn-ak.spotifycdn.com/image/ab67616d00001e02a896d95ee294f8fe78766a4c",
  }),
  Object.freeze({
    kind: "track",
    id: "3uI2KolgU1Pt41ywffsggr",
    label: "Voyaging Star's Farewell",
    sourceUrl: "https://open.spotify.com/track/3uI2KolgU1Pt41ywffsggr",
    thumbnailUrl: "https://image-cdn-ak.spotifycdn.com/image/ab67616d00001e02bd8e1daf8a5400ef9f2ed047",
  }),
  Object.freeze({
    kind: "track",
    id: "7Lm9ji00foCFC68YxVhw9E",
    label: "夏枯れ",
    sourceUrl: "https://open.spotify.com/track/7Lm9ji00foCFC68YxVhw9E",
    thumbnailUrl: "https://image-cdn-ak.spotifycdn.com/image/ab67616d00001e02606f99537e8cd47880be8445",
  }),
  Object.freeze({
    kind: "track",
    id: "0SAnLrDBdgZLg6ioLzRBNn",
    label: "With Glory I Shall Fall",
    sourceUrl: "https://open.spotify.com/track/0SAnLrDBdgZLg6ioLzRBNn",
    thumbnailUrl: "https://image-cdn-ak.spotifycdn.com/image/ab67616d00001e02325bc91aac810be3d328deb9",
  }),
]);

function spotifyEmbedUrl(item) {
  const kind = String(item?.kind || "").trim();
  const spotifyId = String(item?.id || "").trim();
  if (!new Set(["track", "album"]).has(kind)) {
    throw new TypeError("Spotify embed kind must be track or album");
  }
  if (!/^[A-Za-z0-9]{22}$/.test(spotifyId)) {
    throw new TypeError("Spotify id must contain 22 letters or digits");
  }
  return `https://open.spotify.com/embed/${kind}/${spotifyId}?utm_source=generator&theme=0`;
}

function spotifyItemsInOrder(order = []) {
  const byId = new Map(SpotifyEasterEggItems.map((item) => [item.id, item]));
  const resolved = [];
  for (const id of Array.isArray(order) ? order : []) {
    const item = byId.get(String(id || ""));
    if (!item) continue;
    resolved.push(item);
    byId.delete(item.id);
  }
  return [...resolved, ...byId.values()];
}

class SpotifyPlayerWidget extends DashboardWidget {
  constructor(options) {
    super(options);
    if (!this.services.playerSession) {
      throw new TypeError("SpotifyPlayerWidget requires SpotifyPlayerSession");
    }
    this.playerSession = this.services.playerSession;
    this.draggedItemId = "";
    this.compactContainer = null;
    this.playerSession.configure(SpotifyEasterEggItems, {
      order: this.services.readPreference?.("trackOrder"),
    });
    this.unsubscribePlayerSession = this.playerSession.subscribe(() => {
      if (this.compactContainer?.isConnected) this.renderCompact(this.compactContainer);
    });
  }

  get items() {
    return this.playerSession.items();
  }

  activeItem() {
    return this.playerSession.activeItem();
  }

  showsDashboardHeader() {
    return false;
  }

  renderIcons(container) {
    if (!container?.querySelector?.("[data-lucide]") || !window.lucide?.createIcons) return;
    if (!container.isConnected) {
      window.requestAnimationFrame?.(() => {
        if (container.isConnected) this.renderIcons(container);
      });
      return;
    }
    window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } });
    document.documentElement.classList.add("has-lucide-icons");
  }

  renderCompact(container) {
    const item = this.activeItem();
    this.compactContainer = container;
    container.innerHTML = `
      <div class="spotify-player-compact" title="${item.label}">
        <img
          class="spotify-player-cover"
          src="${item.thumbnailUrl}"
          alt="${item.label} 專輯封面"
          loading="lazy"
          decoding="async"
          referrerpolicy="no-referrer"
        >
        <span class="spotify-player-equalizer" aria-hidden="true">
          <i></i><i></i><i></i><i></i>
        </span>
      </div>
    `;
  }

  renderAccountActions() {
    return `
      <div class="spotify-player-account-actions" data-widget-interactive>
        <a
          class="spotify-player-login-link"
          href="${SpotifyAccountLoginUrl}"
          target="_blank"
          rel="noopener noreferrer"
          title="登入 Spotify"
        >
          <span>登入 Spotify</span>
        </a>
        <button
          type="button"
          class="spotify-player-reconnect-button"
          data-spotify-reconnect
          title="登入後重新連線播放器"
          aria-label="登入後重新連線播放器"
        >
          <i data-lucide="refresh-cw" aria-hidden="true"></i>
        </button>
      </div>
    `;
  }

  renderPlaylist() {
    return `
      <aside class="spotify-player-playlist" aria-label="彩蛋播放清單">
        <div class="spotify-player-playlist-heading">
          <strong>播放清單</strong>
          <span>${this.items.length} 首</span>
        </div>
        <div class="spotify-player-playlist-items">
          ${this.items.map((entry, index) => `
            <div class="spotify-player-playlist-row" data-spotify-row-id="${entry.id}">
              <button
                type="button"
                class="spotify-player-drag-handle"
                draggable="true"
                data-spotify-drag-id="${entry.id}"
                title="拖曳調整 ${entry.label} 的順序"
                aria-label="拖曳調整 ${entry.label} 的順序"
              >
                <i data-lucide="grip-vertical" aria-hidden="true"></i>
              </button>
              <button
                type="button"
                data-spotify-item-id="${entry.id}"
                class="spotify-player-track-button${entry.id === this.playerSession.activeItemId ? " is-active" : ""}"
                aria-pressed="${entry.id === this.playerSession.activeItemId ? "true" : "false"}"
              >
                <span class="spotify-player-track-number">${String(index + 1).padStart(2, "0")}</span>
                <span class="spotify-player-track-copy">
                  <strong>${entry.label}</strong>
                  <small>Spotify 單曲</small>
                </span>
                <i data-lucide="music-2" aria-hidden="true"></i>
              </button>
            </div>
          `).join("")}
        </div>
      </aside>
    `;
  }

  selectItem(itemId, container) {
    if (!this.items.some((item) => item.id === itemId)) return;
    this.playerSession.select(itemId);
    const item = this.activeItem();
    const embed = container.querySelector(".spotify-player-embed");
    if (embed) {
      embed.src = spotifyEmbedUrl(item);
      embed.title = `Spotify ${item.label}播放器`;
    }
    container.querySelectorAll("[data-spotify-item-id]").forEach((button) => {
      const active = button.dataset.spotifyItemId === itemId;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    if (this.compactContainer?.isConnected) this.renderCompact(this.compactContainer);
  }

  persistOrder() {
    this.services.writePreference?.("trackOrder", this.items.map((item) => item.id));
  }

  refreshPlaylist(container) {
    const current = container.querySelector(".spotify-player-playlist");
    if (!current) return;
    const template = document.createElement("template");
    template.innerHTML = this.renderPlaylist().trim();
    current.replaceWith(template.content.firstElementChild);
    this.renderItemControls(container);
    this.renderIcons(container);
  }

  moveItem(itemId, targetId, { after = false, container } = {}) {
    if (!this.playerSession.move(itemId, targetId, { after })) return false;
    this.persistOrder();
    this.refreshPlaylist(container);
    return true;
  }

  clearDropIndicators(container) {
    container.querySelectorAll(".spotify-player-playlist-row").forEach((row) => {
      row.classList.remove("is-dragging", "is-drop-before", "is-drop-after");
    });
  }

  bindReconnectControls(container) {
    container.querySelectorAll("[data-spotify-reconnect]").forEach((button) => {
      if (button.dataset.spotifyReconnectBound === "1") return;
      button.dataset.spotifyReconnectBound = "1";
      bindWidgetActionButton(button, () => {
        const item = this.activeItem();
        const embed = container.querySelector(".spotify-player-embed");
        if (!embed || !item) return;
        embed.src = spotifyEmbedUrl(item);
      });
    });
  }

  renderItemControls(container) {
    this.bindReconnectControls(container);
    container.querySelectorAll("[data-spotify-item-id]").forEach((button) => {
      bindWidgetActionButton(button, () => {
        this.selectItem(button.dataset.spotifyItemId, container);
      });
    });
    container.querySelectorAll("[data-spotify-drag-id]").forEach((handle) => {
      const itemId = handle.dataset.spotifyDragId;
      handle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      handle.addEventListener("keydown", (event) => {
        if (!new Set(["ArrowUp", "ArrowDown"]).has(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const index = this.items.findIndex((item) => item.id === itemId);
        const target = this.items[index + (event.key === "ArrowUp" ? -1 : 1)];
        if (!target) return;
        this.moveItem(itemId, target.id, {
          after: event.key === "ArrowDown",
          container,
        });
        container.querySelector(`[data-spotify-drag-id="${itemId}"]`)?.focus();
      });
      handle.addEventListener("dragstart", (event) => {
        this.draggedItemId = itemId;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", itemId);
        handle.closest(".spotify-player-playlist-row")?.classList.add("is-dragging");
      });
      handle.addEventListener("dragend", () => {
        this.draggedItemId = "";
        this.clearDropIndicators(container);
      });
    });
    container.querySelectorAll("[data-spotify-row-id]").forEach((row) => {
      row.addEventListener("dragover", (event) => {
        if (!this.draggedItemId || this.draggedItemId === row.dataset.spotifyRowId) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const after = event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
        this.clearDropIndicators(container);
        row.classList.add(after ? "is-drop-after" : "is-drop-before");
      });
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        const itemId = this.draggedItemId || event.dataTransfer.getData("text/plain");
        const after = event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
        this.moveItem(itemId, row.dataset.spotifyRowId, { after, container });
        this.draggedItemId = "";
        this.clearDropIndicators(container);
      });
    });
  }

  renderExpandedContent(container, { cinema = false } = {}) {
    const item = this.activeItem();
    const embedUrl = spotifyEmbedUrl(item);
    container.innerHTML = `
      <div class="spotify-player-shell${cinema ? " is-cinema" : ""}" data-widget-interactive>
        <div class="spotify-player-main">
          <iframe
            class="spotify-player-embed"
            src="${embedUrl}"
            title="Spotify ${item.label}播放器"
            loading="lazy"
            allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
            allowfullscreen
            referrerpolicy="strict-origin-when-cross-origin"
          ></iframe>
        </div>
        ${cinema ? this.renderPlaylist() : ""}
      </div>
    `;
    this.renderItemControls(container);
  }

  renderCinema(container) {
    const shell = container.querySelector(".spotify-player-shell");
    const main = shell?.querySelector(".spotify-player-main");
    const embed = main?.querySelector(".spotify-player-embed");
    if (!shell || !main || !embed) {
      this.renderTemplate(container, { expanded: true, cinema: true });
      return;
    }
    shell.classList.add("is-cinema");
    if (!shell.querySelector(".spotify-player-playlist")) {
      shell.insertAdjacentHTML("beforeend", this.renderPlaylist());
    }
    this.renderItemControls(container);
    this.renderIcons(container);
  }

  renderTemplate(container, { expanded = false, cinema = false } = {}) {
    container.classList.add("widget-template", "widget-template-spotify-player");
    container.classList.toggle("is-expanded", expanded);
    if (expanded) this.renderExpandedContent(container, { cinema });
    else this.renderCompact(container);
    this.renderIcons(container);
  }

  renderExpanded() {
    const pane = super.renderExpanded();
    pane.classList.add("spotify-player-popover");
    const header = pane.querySelector(".widget-popover-header");
    const actions = document.createElement("div");
    actions.className = "spotify-player-popover-actions";
    const accountTemplate = document.createElement("template");
    accountTemplate.innerHTML = this.renderAccountActions().trim();
    const accountActions = accountTemplate.content.firstElementChild;
    const cinemaButton = document.createElement("button");
    cinemaButton.type = "button";
    cinemaButton.className = "spotify-player-cinema-button";
    cinemaButton.title = "展開播放清單";
    cinemaButton.setAttribute("aria-label", "展開播放清單");
    cinemaButton.innerHTML = '<i data-lucide="list-music" aria-hidden="true"></i>';
    bindWidgetActionButton(cinemaButton, () => pane.click());
    actions.append(accountActions, cinemaButton);
    header?.append(actions);
    this.bindReconnectControls(pane);
    this.renderIcons(pane);
    return pane;
  }

  popoverRetentionKey() {
    return "spotify-player-session";
  }

  dispose() {
    this.unsubscribePlayerSession?.();
    this.unsubscribePlayerSession = null;
    this.compactContainer = null;
  }
}

Object.assign(window.WidgetCapabilities ||= {}, {
  SpotifyEasterEggItems,
  SpotifyAccountLoginUrl,
  SpotifyPlayerWidget,
  spotifyItemsInOrder,
  spotifyEmbedUrl,
});
})();
