const toggle = document.querySelector(".menu-toggle");
const nav = document.querySelector(".site-nav");

toggle?.addEventListener("click", () => {
  const open = nav.classList.toggle("is-open");
  toggle.setAttribute("aria-expanded", String(open));
});

nav?.addEventListener("click", (event) => {
  if (event.target instanceof HTMLAnchorElement) {
    nav.classList.remove("is-open");
    toggle?.setAttribute("aria-expanded", "false");
  }
});

const updateScrollMotion = () => {
  const progress = Math.min(1, window.scrollY / Math.max(1, window.innerHeight));
  document.documentElement.style.setProperty("--scroll-shift", progress.toFixed(3));
};

const updatePointerGlow = (event) => {
  const x = `${Math.round((event.clientX / window.innerWidth) * 100)}%`;
  const y = `${Math.round((event.clientY / window.innerHeight) * 100)}%`;
  document.documentElement.style.setProperty("--cursor-x", x);
  document.documentElement.style.setProperty("--cursor-y", y);
};

window.addEventListener("scroll", updateScrollMotion, { passive: true });
window.addEventListener("pointermove", updatePointerGlow, { passive: true });
updateScrollMotion();

const revealTargets = document.querySelectorAll(".system-feature");

if (revealTargets.length && "IntersectionObserver" in window) {
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -12%", threshold: 0.16 },
  );

  revealTargets.forEach((target) => revealObserver.observe(target));
} else {
  revealTargets.forEach((target) => target.classList.add("is-visible"));
}

const aoiLayout = document.querySelector(".aoi-layout");
const aoiItems = document.querySelectorAll("[data-aoi-target]");

aoiItems.forEach((item) => {
  const activate = () => {
    if (aoiLayout) aoiLayout.dataset.activeAoi = item.dataset.aoiTarget || "";
  };
  const deactivate = () => {
    if (aoiLayout?.dataset.activeAoi === item.dataset.aoiTarget) delete aoiLayout.dataset.activeAoi;
  };

  item.addEventListener("pointerenter", activate);
  item.addEventListener("pointerleave", () => {
    if (document.activeElement !== item) deactivate();
  });
  item.addEventListener("focus", activate);
  item.addEventListener("blur", deactivate);
});

const storySelectors = document.querySelectorAll("[data-story-selector]");

storySelectors.forEach((selector) => {
  const cards = Array.from(selector.querySelectorAll("[data-story-card]"));
  const selectCard = (selectedCard, { moveFocus = false } = {}) => {
    cards.forEach((card) => {
      const selected = card === selectedCard;
      card.classList.toggle("is-active", selected);
      card.setAttribute("aria-checked", String(selected));
      card.tabIndex = selected ? 0 : -1;
    });
    if (moveFocus) selectedCard.focus();
  };

  selector.addEventListener("click", (event) => {
    const card = event.target.closest("[data-story-card]");
    if (card && selector.contains(card)) selectCard(card);
  });

  selector.addEventListener("keydown", (event) => {
    const current = event.target.closest("[data-story-card]");
    if (!current || !selector.contains(current)) return;
    const currentIndex = cards.indexOf(current);
    let nextIndex = currentIndex;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % cards.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + cards.length) % cards.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = cards.length - 1;
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      selectCard(current);
      return;
    }
    if (nextIndex === currentIndex) return;
    event.preventDefault();
    selectCard(cards[nextIndex], { moveFocus: true });
  });
});

const memberDialog = document.querySelector("[data-member-dialog]");
const memberCards = document.querySelectorAll(".member-card");
const memberClose = memberDialog?.querySelector("[data-member-close]");

memberCards.forEach((card) => {
  card.addEventListener("click", () => {
    if (!(memberDialog instanceof HTMLDialogElement)) return;

    memberDialog.querySelector("[data-member-dialog-role]").textContent = card.dataset.memberRole || "";
    memberDialog.querySelector("[data-member-dialog-name]").textContent = card.dataset.memberName || "";
    memberDialog.querySelector("[data-member-dialog-description]").textContent = card.dataset.memberDescription || "";
    const portrait = memberDialog.querySelector("[data-member-dialog-image]");
    portrait.src = card.dataset.memberImage || "";
    portrait.alt = card.dataset.memberName || "";

    const tags = memberDialog.querySelector("[data-member-dialog-tags]");
    tags.replaceChildren(
      ...(card.dataset.memberTags || "")
        .split(",")
        .filter(Boolean)
        .map((tag) => Object.assign(document.createElement("span"), { textContent: tag })),
    );

    const github = memberDialog.querySelector("[data-member-dialog-github]");
    const githubHandle = github.querySelector("[data-member-dialog-github-handle]");
    const githubUrl = card.dataset.memberGithub || "";
    github.hidden = !githubUrl;
    if (githubUrl) {
      github.href = githubUrl;
      github.setAttribute("aria-label", `${card.dataset.memberName || "成員"} 的 GitHub`);
      githubHandle.textContent = githubUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
    } else {
      github.removeAttribute("href");
      github.removeAttribute("aria-label");
      githubHandle.textContent = "";
    }

    memberDialog.showModal();
  });
});

memberClose?.addEventListener("click", () => memberDialog?.close());
memberDialog?.addEventListener("click", (event) => {
  if (event.target === memberDialog) memberDialog.close();
});
