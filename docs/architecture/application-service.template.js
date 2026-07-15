// Stateless Application Service template. Replace the example names, not the boundaries.
function normalizeExampleCommand(command = {}) {
  return Object.freeze({
    entityId: String(command.entityId || "").trim(),
    requestedAt: String(command.requestedAt || "").trim(),
  });
}

function createExampleApplicationService({ repository, mapper, eventSink } = {}) {
  if (!repository?.load || typeof mapper !== "function" || !eventSink?.record) {
    throw new TypeError("ExampleApplicationService requires repository, mapper and eventSink");
  }

  async function execute(command) {
    const normalized = normalizeExampleCommand(command);
    if (!normalized.entityId) throw new TypeError("entityId is required");

    eventSink.record({ type: "EXAMPLE_REQUESTED", entityId: normalized.entityId });
    const source = await repository.load(normalized);
    const result = mapper(source);
    eventSink.record({ type: "EXAMPLE_COMPLETED", entityId: normalized.entityId });
    return result;
  }

  return Object.freeze({ execute });
}

// Keep this a factory while it is stateless. If it later owns mutable state,
// identity, lifecycle, or a runtime resource, replace it with a DI-created class.
