import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();
const flush = () => new Promise((resolve) => setImmediate(resolve));
const encoder = new TextEncoder();

function loadBroker(fetchFn, { maxBatchSize = 3, sourceCapacity = 2 } = {}) {
  const events = [];
  const context = {
    AbortController,
    Error,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    TextDecoder,
    console,
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(root, "static/js/services/query-broker.js"), "utf8"),
    context,
  );
  const QueryBroker = vm.runInContext("globalThis.QueryBroker", context);
  return {
    broker: new QueryBroker({
      fetchFn,
      eventLog: { record: (type, detail) => events.push({ type, detail }) },
      clock: { now: () => performance.now() },
      priorityForLane: (lane) => ({
        "map-current": 0,
        "playback-target": 5,
        "playback-window": 10,
        "widget-interactive": 20,
        "widget-auto": 40,
        background: 40,
      })[lane] ?? 40,
      maxBatchSizeProvider: () => maxBatchSize,
      sourceCapacityProvider: () => sourceCapacity,
    }),
    context,
    events,
  };
}

function operation(date, patch = {}) {
  return {
    datasetId: "ocean",
    date,
    bbox: "120,10,130,20",
    columns: "render",
    limit: "max",
    resolution: 4,
    queryResolution: 4,
    ...patch,
  };
}

function responseFor(envelope, resultFor) {
  const events = [{ type: "batch.started", batch_id: envelope.batch_id }];
  for (const item of envelope.operations) {
    events.push({
      type: "batch.result",
      batch_id: envelope.batch_id,
      operation_id: item.operation_id,
      ...resultFor(item),
    });
  }
  events.push({ type: "batch.completed", batch_id: envelope.batch_id });
  return new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

test("broker limits each physical request to source capacity and demultiplexes results", async () => {
  const envelopes = [];
  const { broker, events } = loadBroker(async (_url, options) => {
    const envelope = JSON.parse(options.body);
    envelopes.push(envelope);
    return responseFor(envelope, (item) => ({
      status: "ok",
      packet: { rows: [{ date: item.params.date }], row_count: 1 },
    }));
  });

  const results = await Promise.all([
    broker.requestSampledGrid(operation("2020-01-01"), {
      operationId: "frame-1",
      lane: "playback-window",
    }),
    broker.requestSampledGrid(operation("2020-01-02"), {
      operationId: "frame-2",
      lane: "playback-window",
    }),
    broker.requestSampledGrid(operation("2020-01-03"), {
      operationId: "frame-3",
      lane: "playback-window",
    }),
  ]);
  await flush();

  assert.equal(envelopes.length, 2);
  assert.equal(envelopes[0].schema, "query_batch.v1");
  assert.deepEqual(envelopes.map((envelope) => envelope.operations.length), [2, 1]);
  assert.deepEqual([...results.map((packet) => packet.rows[0].date)], [
    "2020-01-01",
    "2020-01-02",
    "2020-01-03",
  ]);
  assert.equal(events.filter((event) => event.type === "HTTP_BATCH_STARTED").length, 2);
  assert.equal(events.filter((event) => event.type === "HTTP_BATCH_FINISHED").length, 2);
});

test("sampled-grid source transport is independent of camera zoom and latitude", () => {
  const { context } = loadBroker(async () => new Response());
  const compiled = context.sampledGridBatchOperation(operation("2020-01-01", {
    zoom: 9,
    latitude: 23.5,
  }), "frame-1");

  assert.equal(compiled.params.resolution, 4);
  assert.equal("zoom" in compiled.params, false);
  assert.equal("latitude" in compiled.params, false);
});

test("render transport projection inflates before consumers receive canonical rows", () => {
  const { context } = loadBroker(async () => new Response());
  const packet = context.inflateSampledGridRenderPacket({
    row_contract_version: "rrkal.sampled_grid.v1",
    rows: [["cell-a", 3]],
    transport_projection: {
      schema: "rrkal.sampled_grid.render.v1",
      row_fields: ["cell_id", "value"],
      frame_fields: { date: "2020-01-01", resolution_km: 4 },
    },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(packet.rows)), [{
    date: "2020-01-01",
    resolution_km: 4,
    cell_id: "cell-a",
    value: 3,
  }]);
  assert.equal("transport_projection" in packet, false);
});

test("datasets sharing one physical provider combine within its capacity", async () => {
  const envelopes = [];
  const { broker } = loadBroker(async (_url, options) => {
    const envelope = JSON.parse(options.body);
    envelopes.push(envelope);
    return responseFor(envelope, (item) => ({
      status: "ok",
      packet: { rows: [{ dataset: item.dataset_id }] },
    }));
  });

  const packets = await Promise.all([
    broker.requestSampledGrid(operation("2020-01-01", {
      datasetId: "chlorophyll",
      transportKey: "provider:8791",
    }), { operationId: "chlor", lane: "playback-window" }),
    broker.requestSampledGrid(operation("2020-01-01", {
      datasetId: "temperature",
      transportKey: "provider:8791",
    }), { operationId: "temp", lane: "playback-window" }),
  ]);

  assert.equal(envelopes.length, 1);
  assert.deepEqual(envelopes[0].operations.map((item) => item.dataset_id), [
    "chlorophyll",
    "temperature",
  ]);
  assert.equal("source_key" in envelopes[0].operations[0], false);
  assert.deepEqual(packets.map((packet) => packet.rows[0].dataset), ["chlorophyll", "temperature"]);
});

test("different physical providers retain independent batch lanes", async () => {
  const envelopes = [];
  const { broker } = loadBroker(async (_url, options) => {
    const envelope = JSON.parse(options.body);
    envelopes.push(envelope);
    return responseFor(envelope, () => ({ status: "ok", packet: { rows: [] } }));
  });

  await Promise.all([
    broker.requestSampledGrid(operation("2020-01-01", {
      datasetId: "chlorophyll",
      transportKey: "provider:8791",
    }), { operationId: "remote", lane: "playback-window" }),
    broker.requestSampledGrid(operation("2020-01-01", {
      datasetId: "gfw",
      transportKey: "provider:mysql",
    }), { operationId: "local", lane: "playback-window" }),
  ]);

  assert.equal(envelopes.length, 2);
  assert.deepEqual(
    envelopes.map((envelope) => envelope.operations[0].dataset_id).sort(),
    ["chlorophyll", "gfw"],
  );
});

test("one physical provider backfills a released slot without exceeding capacity", async () => {
  const streams = [];
  const envelopes = [];
  const { broker } = loadBroker(async (_url, options) => {
    const envelope = JSON.parse(options.body);
    envelopes.push(envelope);
    let controller;
    const stream = new ReadableStream({
      start(nextController) { controller = nextController; },
    });
    streams.push({ controller, envelope });
    return new Response(stream, { status: 200 });
  }, { maxBatchSize: 1 });

  const first = broker.requestSampledGrid(operation("2020-01-01", {
    datasetId: "chlorophyll",
    transportKey: "provider:8791",
  }), { operationId: "first", lane: "playback-window" });
  const second = broker.requestSampledGrid(operation("2020-01-02", {
    datasetId: "temperature",
    transportKey: "provider:8791",
  }), { operationId: "second", lane: "playback-window" });
  const third = broker.requestSampledGrid(operation("2020-01-03", {
    datasetId: "chlorophyll",
    transportKey: "provider:8791",
  }), { operationId: "third", lane: "playback-window" });
  await flush();

  assert.equal(envelopes.length, 2);
  streams[0].controller.enqueue(encoder.encode(`${JSON.stringify({
    type: "batch.result",
    batch_id: streams[0].envelope.batch_id,
    operation_id: "first",
    status: "ok",
    packet: { rows: [1] },
  })}\n`));
  assert.equal((await first).rows[0], 1);
  await flush();
  assert.equal(envelopes.length, 3);

  streams[1].controller.enqueue(encoder.encode(`${JSON.stringify({
    type: "batch.result",
    batch_id: streams[1].envelope.batch_id,
    operation_id: "second",
    status: "ok",
    packet: { rows: [2] },
  })}\n`));
  assert.equal((await second).rows[0], 2);
  streams[2].controller.enqueue(encoder.encode(`${JSON.stringify({
    type: "batch.result",
    batch_id: streams[2].envelope.batch_id,
    operation_id: "third",
    status: "ok",
    packet: { rows: [3] },
  })}\n`));
  assert.equal((await third).rows[0], 3);
  for (const item of streams) item.controller.close();
});

test("broker streams the first result without waiting for the rest of the batch", async () => {
  let streamController;
  let envelope;
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
    },
  });
  const { broker } = loadBroker(async (_url, options) => {
    envelope = JSON.parse(options.body);
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  });
  let secondSettled = false;
  const first = broker.requestSampledGrid(operation("2020-01-01"), {
    operationId: "frame-1",
    lane: "playback-window",
  });
  const second = broker.requestSampledGrid(operation("2020-01-02"), {
    operationId: "frame-2",
    lane: "playback-window",
  }).finally(() => { secondSettled = true; });
  await flush();

  streamController.enqueue(encoder.encode(`${JSON.stringify({
    type: "batch.started",
    batch_id: envelope.batch_id,
  })}\n${JSON.stringify({
    type: "batch.result",
    batch_id: envelope.batch_id,
    operation_id: "frame-1",
    status: "ok",
    packet: { rows: [1] },
  })}\n`));
  assert.equal((await first).rows[0], 1);
  assert.equal(secondSettled, false);

  streamController.enqueue(encoder.encode(`${JSON.stringify({
    type: "batch.result",
    batch_id: envelope.batch_id,
    operation_id: "frame-2",
    status: "ok",
    packet: { rows: [2] },
  })}\n${JSON.stringify({
    type: "batch.completed",
    batch_id: envelope.batch_id,
  })}\n`));
  streamController.close();
  assert.equal((await second).rows[0], 2);
});

test("one failed operation does not reject successful consumers in the same batch", async () => {
  const { broker } = loadBroker(async (_url, options) => {
    const envelope = JSON.parse(options.body);
    return responseFor(envelope, (item) => (
      item.operation_id === "bad"
        ? { status: "error", error: "source unavailable" }
        : { status: "ok", packet: { rows: [item.operation_id] } }
    ));
  });
  const good = broker.requestSampledGrid(operation("2020-01-01"), {
    operationId: "good",
    lane: "widget-auto",
  });
  const bad = broker.requestSampledGrid(operation("2020-01-02"), {
    operationId: "bad",
    lane: "widget-auto",
  });
  const badAssertion = assert.rejects(bad, (error) => (
    error?.name === "QueryBatchOperationError" && error.message === "source unavailable"
  ));

  assert.equal((await good).rows[0], "good");
  await badAssertion;
});

test("cancelling one operation keeps the shared physical request alive", async () => {
  let streamController;
  let envelope;
  let transportAborted = false;
  const stream = new ReadableStream({ start: (controller) => { streamController = controller; } });
  const { broker } = loadBroker(async (_url, options) => {
    envelope = JSON.parse(options.body);
    options.signal.addEventListener("abort", () => { transportAborted = true; }, { once: true });
    return new Response(stream, { status: 200 });
  });
  const firstController = new AbortController();
  const cancelled = broker.requestSampledGrid(operation("2020-01-01"), {
    operationId: "cancelled",
    lane: "widget-auto",
    signal: firstController.signal,
  });
  const retained = broker.requestSampledGrid(operation("2020-01-02"), {
    operationId: "retained",
    lane: "widget-auto",
  });
  await flush();
  firstController.abort();
  await assert.rejects(cancelled, (error) => error?.name === "AbortError");
  assert.equal(transportAborted, false);

  streamController.enqueue(encoder.encode(`${JSON.stringify({
    type: "batch.started",
    batch_id: envelope.batch_id,
  })}\n${JSON.stringify({
    type: "batch.result",
    batch_id: envelope.batch_id,
    operation_id: "retained",
    status: "ok",
    packet: { rows: [2] },
  })}\n${JSON.stringify({
    type: "batch.completed",
    batch_id: envelope.batch_id,
  })}\n`));
  streamController.close();
  assert.equal((await retained).rows[0], 2);
});

test("broker releases source capacity as soon as an operation result arrives", async () => {
  let firstController;
  let firstEnvelope;
  let firstCancelled = false;
  let callCount = 0;
  const firstStream = new ReadableStream({
    start(controller) { firstController = controller; },
    cancel() { firstCancelled = true; },
  });
  const { broker } = loadBroker(async (_url, options) => {
    callCount += 1;
    const envelope = JSON.parse(options.body);
    if (callCount === 1) {
      firstEnvelope = envelope;
      return new Response(firstStream, { status: 200 });
    }
    return responseFor(envelope, () => ({ status: "ok", packet: { rows: [2] } }));
  }, { sourceCapacity: 1 });
  const first = broker.requestSampledGrid(operation("2020-01-01"), {
    operationId: "first-open-stream",
    lane: "playback-window",
  });
  await flush();
  firstController.enqueue(encoder.encode(`${JSON.stringify({
    type: "batch.result",
    batch_id: firstEnvelope.batch_id,
    operation_id: "first-open-stream",
    status: "ok",
    packet: { rows: [1] },
  })}\n`));
  assert.equal((await first).rows[0], 1);
  await flush();

  const second = broker.requestSampledGrid(operation("2020-01-02"), {
    operationId: "second-after-open-stream",
    lane: "playback-window",
  });
  assert.equal((await second).rows[0], 2);
  assert.equal(callCount, 2);
  assert.equal(firstCancelled, false);
  firstController.close();
});

test("foreground demand uses the next released slot without requerying active work", async () => {
  let firstStreamController;
  let firstStreamCancelled = false;
  const envelopes = [];
  const completionOrder = [];
  const { broker, events } = loadBroker(async (_url, options) => {
    const envelope = JSON.parse(options.body);
    envelopes.push(envelope);
    if (envelopes.length === 1) {
      const stream = new ReadableStream({
        start(controller) { firstStreamController = controller; },
        cancel() { firstStreamCancelled = true; },
      });
      return new Response(stream, { status: 200 });
    }
    return responseFor(envelope, (item) => ({
      status: "ok",
      packet: { rows: [item.operation_id] },
    }));
  });
  const firstBackground = broker.requestSampledGrid(operation("2020-01-01"), {
    operationId: "background-frame-1",
    lane: "background",
  }).then((packet) => {
    completionOrder.push("background-1");
    return packet;
  });
  const secondBackground = broker.requestSampledGrid(operation("2020-01-02"), {
    operationId: "background-frame-2",
    lane: "background",
  }).then((packet) => {
    completionOrder.push("background-2");
    return packet;
  });
  await flush();
  const foreground = broker.requestSampledGrid(operation("2020-01-03"), {
    operationId: "foreground-frame",
    lane: "map-current",
  }).then((packet) => {
    completionOrder.push("foreground");
    return packet;
  });

  firstStreamController.enqueue(encoder.encode(`${JSON.stringify({
    type: "batch.result",
    batch_id: envelopes[0].batch_id,
    operation_id: "background-frame-1",
    status: "ok",
    packet: { rows: ["background-frame-1"] },
  })}\n`));

  assert.equal((await firstBackground).rows[0], "background-frame-1");
  assert.equal((await foreground).rows[0], "foreground-frame");
  firstStreamController.enqueue(encoder.encode(`${JSON.stringify({
    type: "batch.result",
    batch_id: envelopes[0].batch_id,
    operation_id: "background-frame-2",
    status: "ok",
    packet: { rows: ["background-frame-2"] },
  })}\n${JSON.stringify({
    type: "batch.completed",
    batch_id: envelopes[0].batch_id,
  })}\n`));
  firstStreamController.close();
  assert.equal((await secondBackground).rows[0], "background-frame-2");
  assert.equal(firstStreamCancelled, false);
  assert.deepEqual(completionOrder, ["background-1", "foreground", "background-2"]);
  assert.deepEqual(envelopes.map((envelope) => envelope.operations.map((item) => item.operation_id)), [
    ["background-frame-1", "background-frame-2"],
    ["foreground-frame"],
  ]);
  assert.equal(events.filter((event) => event.type === "HTTP_BATCH_PREEMPT_REQUESTED").length, 0);
  assert.equal(events.filter((event) => event.type === "HTTP_BATCH_PREEMPTED").length, 0);
});

test("promoting an existing operation changes the single broker queue without duplicating transport", async () => {
  let streamController;
  let streamCancelled = false;
  const envelopes = [];
  const { broker, events } = loadBroker(async (_url, options) => {
    const envelope = JSON.parse(options.body);
    envelopes.push(envelope);
    if (envelopes.length === 1) {
      return new Response(new ReadableStream({
        start(controller) { streamController = controller; },
        cancel() { streamCancelled = true; },
      }), { status: 200 });
    }
    return responseFor(envelope, (item) => ({
      status: "ok",
      packet: { rows: [item.operation_id] },
    }));
  });
  const first = broker.requestSampledGrid(operation("2020-01-01"), {
    operationId: "frame-1",
    lane: "playback-window",
  });
  const promotedFrame = broker.requestSampledGrid(operation("2020-01-02"), {
    operationId: "frame-2",
    lane: "playback-window",
  });
  await flush();

  assert.equal(broker.promoteSampledGrid("frame-2", "playback-target"), true);
  for (const operationId of ["frame-1", "frame-2"]) {
    streamController.enqueue(encoder.encode(`${JSON.stringify({
      type: "batch.result",
      batch_id: envelopes[0].batch_id,
      operation_id: operationId,
      status: "ok",
      packet: { rows: [operationId] },
    })}\n`));
  }
  streamController.close();

  assert.equal((await first).rows[0], "frame-1");
  assert.equal((await promotedFrame).rows[0], "frame-2");
  assert.equal(streamCancelled, false);
  assert.deepEqual(envelopes.map((envelope) => envelope.operations.map((item) => item.operation_id)), [
    ["frame-1", "frame-2"],
  ]);
  const promoted = events.find((event) => event.type === "TASK_PROMOTED");
  assert.equal(promoted?.detail.previous_lane, "playback-window");
  assert.equal(promoted?.detail.requested_lane, "playback-target");
});

test("promoting the first unfinished operation keeps the active batch intact", async () => {
  let streamController;
  const envelopes = [];
  const { broker, events } = loadBroker(async (_url, options) => {
    const envelope = JSON.parse(options.body);
    envelopes.push(envelope);
    return new Response(new ReadableStream({
      start(controller) { streamController = controller; },
    }), { status: 200 });
  });
  const first = broker.requestSampledGrid(operation("2020-01-01"), {
    operationId: "frame-1",
    lane: "playback-window",
  });
  const second = broker.requestSampledGrid(operation("2020-01-02"), {
    operationId: "frame-2",
    lane: "playback-window",
  });
  await flush();

  assert.equal(broker.promoteSampledGrid("frame-1", "playback-target"), true);
  for (const operationId of ["frame-1", "frame-2"]) {
    streamController.enqueue(encoder.encode(`${JSON.stringify({
      type: "batch.result",
      batch_id: envelopes[0].batch_id,
      operation_id: operationId,
      status: "ok",
      packet: { rows: [operationId] },
    })}\n`));
  }
  streamController.close();

  assert.equal((await first).rows[0], "frame-1");
  assert.equal((await second).rows[0], "frame-2");
  assert.equal(envelopes.length, 1);
  assert.equal(events.filter((event) => event.type === "HTTP_BATCH_PREEMPT_REQUESTED").length, 0);
  assert.equal(events.filter((event) => event.type === "HTTP_BATCH_PREEMPTED").length, 0);
  const promoted = events.find((event) => event.type === "TASK_PROMOTED");
  assert.equal(promoted?.detail.preempt_required, false);
});
