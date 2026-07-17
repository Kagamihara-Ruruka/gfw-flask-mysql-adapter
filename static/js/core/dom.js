const $ = (id) => document.getElementById(id);

function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDisplayNumber(value, { maximumFractionDigits = 2 } = {}) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return number.toLocaleString("zh-TW", {
    maximumFractionDigits: Math.max(0, Number(maximumFractionDigits) || 0),
  });
}

function formatResolutionKm(value) {
  const formatted = formatDisplayNumber(value, { maximumFractionDigits: 2 });
  return formatted === "-" ? formatted : `${formatted} km`;
}
