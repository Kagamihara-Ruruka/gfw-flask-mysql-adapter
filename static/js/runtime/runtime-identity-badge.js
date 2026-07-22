(function () {
  function basename(value) {
    return String(value || "no source").replace(/\\/g, "/").split("/").pop();
  }

  function renderIdentity(badge, packet) {
    const configState = packet.config_state?.status || "effective";
    const blocked = packet.consistency_status === "blocked";
    const failed = configState === "failed";
    const pending = configState === "pending_restart" || configState === "validated";
    badge.classList.toggle("is-blocked", blocked || failed);
    badge.classList.toggle("is-pending", !blocked && !failed && pending);
    badge.replaceChildren();

    const profile = document.createElement("strong");
    profile.textContent = `${packet.profile || "UNKNOWN"} · GEN ${packet.runtime_generation ?? "?"}`;
    const backend = document.createElement("span");
    backend.textContent = `${packet.query_backend || "unknown"} · ${packet.connection_ref || "no connection"}`;
    const source = document.createElement("small");
    source.textContent = blocked
      ? packet.warning || "Runtime identity mismatch"
      : failed
        ? `${basename(packet.source_config_path)} · APPLY FAILED`
        : `${basename(packet.source_config_path)} · ${pending ? "PENDING RESTART" : "EFFECTIVE"}`;
    const configError = packet.config_state?.error;
    badge.append(profile, backend, source);
    badge.title = [
      packet.runtime_instance_id,
      packet.runtime_fingerprint,
      packet.source_config_path,
      packet.warning,
      configError && `${configError.stage || "config"}: ${configError.message || "failed"}`,
    ].filter(Boolean).join("\n");
  }

  async function loadIdentity() {
    const badge = document.querySelector("[data-runtime-identity-endpoint]");
    if (!badge) {
      return;
    }
    const endpoint = badge.dataset.runtimeIdentityEndpoint;
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      const packet = await response.json();
      if (!response.ok) {
        throw new Error(packet.error || `HTTP ${response.status}`);
      }
      renderIdentity(badge, packet);
    } catch (error) {
      badge.classList.add("is-blocked");
      badge.querySelector("small").textContent = `IDENTITY ERROR · ${error.message}`;
      badge.title = error.stack || error.message;
    }
  }

  window.addEventListener("DOMContentLoaded", loadIdentity, { once: true });
})();
