import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const source = fs.readFileSync(
  path.join(process.cwd(), "static/js/ui/settings/hardware-settings.js"),
  "utf8",
);

function loadHardwareSettings() {
  const elements = new Map();
  for (const id of [
    "hardware-mode-auto",
    "hardware-mode-webgl",
    "hardware-mode-cpu",
  ]) {
    elements.set(id, { checked: false, disabled: false });
    elements.set(`${id}-label`, { textContent: "" });
  }
  const state = {
    browserProfile: { hardwareMode: "auto" },
    renderCapability: null,
  };
  const rendererCapabilityState = {
    setHardwareMode(mode) {
      state.renderCapability = {
        server: { policy: {} },
        browser: {
          webgl: { available: false },
          webgpu: { available: false },
        },
        runtime: { webgl: { available: false } },
        policy: {
          hardware_acceleration: mode,
          force_cpu: mode === "off",
          allow_webgl: mode !== "off",
        },
      };
      return state.renderCapability;
    },
  };
  let profileNotifications = 0;
  const context = createContext({
    console,
    state,
    window: {},
    RendererCapabilityState: rendererCapabilityState,
    globalThis: null,
    $: (id) => elements.get(id) || null,
    notifyBrowserProfileChanged: () => {
      profileNotifications += 1;
    },
  });
  context.globalThis = context;
  runInContext(source, context);
  return { context, elements, state, notifications: () => profileNotifications };
}

test("hardware capability bootstrap fallback does not overwrite browser preference", () => {
  const runtime = loadHardwareSettings();

  runtime.context.syncHardwareSettingsControls();

  assert.equal(runtime.state.browserProfile.hardwareMode, "auto");
  assert.equal(runtime.notifications(), 0);
  assert.equal(runtime.elements.get("hardware-mode-cpu").checked, true);
  assert.equal(runtime.state.renderCapability.policy.force_cpu, true);
});
