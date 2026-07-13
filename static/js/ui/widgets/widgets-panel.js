(() => {
  if (!window.WidgetRuntimeReady) {
    throw new Error("Widgets runtime modules were not loaded before the compatibility entrypoint.");
  }
})();
