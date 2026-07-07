const ControlButtons = (() => {
  function renderIcons() {
    if (!window.lucide?.createIcons) return;
    window.lucide.createIcons({
      attrs: {
        width: 18,
        height: 18,
        "stroke-width": 2.4,
      },
    });
    document.documentElement.classList.add("has-lucide-icons");
  }

  function setIcon(id, iconName, fallback, label) {
    const button = $(id);
    if (!button) return;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = [
      `<span class="control-icon-fallback" aria-hidden="true">${fallback}</span>`,
      `<i class="control-icon" data-lucide="${iconName}" aria-hidden="true"></i>`,
    ].join("");
    renderIcons();
  }

  function setPressedFeedback(button, active) {
    if (button.disabled) return;
    button.classList.toggle("is-pressing", active);
  }

  function pulseClickFeedback(button) {
    if (button.disabled) return;
    button.classList.remove("is-click-pulse");
    void button.offsetWidth;
    button.classList.add("is-click-pulse");
    window.setTimeout(() => button.classList.remove("is-click-pulse"), 180);
  }

  function bindFeedback(ids) {
    for (const id of ids) {
      const button = $(id);
      if (!button) continue;
      button.addEventListener("pointerdown", () => setPressedFeedback(button, true));
      button.addEventListener("pointerup", () => setPressedFeedback(button, false));
      button.addEventListener("pointerleave", () => setPressedFeedback(button, false));
      button.addEventListener("pointercancel", () => setPressedFeedback(button, false));
      button.addEventListener("keydown", (event) => {
        if (event.key === " " || event.key === "Enter") {
          setPressedFeedback(button, true);
        }
      });
      button.addEventListener("keyup", (event) => {
        if (event.key === " " || event.key === "Enter") {
          setPressedFeedback(button, false);
        }
      });
      button.addEventListener("blur", () => setPressedFeedback(button, false));
      button.addEventListener("click", () => pulseClickFeedback(button));
    }
  }

  return {
    bindFeedback,
    renderIcons,
    setIcon,
  };
})();
