(function () {
  function element(id) {
    return document.getElementById(id);
  }

  function setHidden(target, hidden) {
    if (!target) {
      return;
    }
    if (hidden) {
      target.setAttribute("hidden", "");
    } else {
      target.removeAttribute("hidden");
    }
  }

  function isHidden(target) {
    return !target || target.hasAttribute("hidden");
  }

  function setMessage(message, isError = false) {
    const target = element("developer-config-message");
    if (!target) {
      return;
    }
    target.textContent = message || "";
    target.classList.toggle("is-error", Boolean(isError));
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) {
      return "-";
    }
    if (bytes < 1024) {
      return `${bytes.toLocaleString("zh-TW", { maximumFractionDigits: 0 })} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toLocaleString("zh-TW", { maximumFractionDigits: 1 })} KB`;
    }
    return `${(bytes / 1024 / 1024).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} MB`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function sanitizeIdentifier(value, fallback) {
    const cleaned = String(value || "")
      .trim()
      .replace(/[^A-Za-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!cleaned || /^[0-9]/.test(cleaned)) {
      return fallback;
    }
    return cleaned;
  }

  function sanitizeFilename(value, fallback) {
    const cleaned = String(value || "")
      .trim()
      .replace(/[^A-Za-z0-9_.-]+/g, "_")
      .replace(/^[_ .-]+|[_ .-]+$/g, "");
    const name = cleaned || fallback;
    return name.toLowerCase().endsWith(".json") ? name : `${name}.json`;
  }

  function commaList(value) {
    return String(value || "")
      .split(",")
      .map((item) => sanitizeIdentifier(item, ""))
      .filter(Boolean);
  }

  async function jsonOrError(response, fallbackMessage) {
    const packet = await response.json();
    if (!response.ok) {
      throw new Error(packet.error || fallbackMessage);
    }
    return packet;
  }

  window.DeveloperUtils = {
    element,
    setHidden,
    isHidden,
    setMessage,
    formatBytes,
    escapeHtml,
    sanitizeIdentifier,
    sanitizeFilename,
    commaList,
    jsonOrError,
  };
})();
