const PlaybackSnapshotSplitter = (() => {
  const WORKER_URL = "/static/js/workers/snapshot-split-worker.js";

  function mergeSnapshots(target, source) {
    for (const [date, rows] of Object.entries(source || {})) {
      if (!target[date]) target[date] = [];
      target[date].push(...rows);
    }
    return target;
  }

  function splitSync(rows, { dateColumn = "date", dates = [] } = {}) {
    const allowed = Array.isArray(dates) && dates.length ? new Set(dates) : null;
    const snapshots = {};
    for (const row of rows || []) {
      const date = row?.[dateColumn];
      if (!date || (allowed && !allowed.has(date))) continue;
      if (!snapshots[date]) snapshots[date] = [];
      snapshots[date].push(row);
    }
    return snapshots;
  }

  function chunkRows(rows, workerCount) {
    const chunks = Array.from({ length: workerCount }, () => []);
    rows.forEach((row, index) => {
      chunks[index % workerCount].push(row);
    });
    return chunks.filter((chunk) => chunk.length);
  }

  function runWorker(chunk, options) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_URL);
      worker.onmessage = (event) => {
        worker.terminate();
        resolve(event.data?.snapshots || {});
      };
      worker.onerror = (event) => {
        worker.terminate();
        reject(event.error || new Error(event.message || "snapshot split worker failed"));
      };
      worker.postMessage({
        rows: chunk,
        dateColumn: options.dateColumn,
        allowedDates: options.dates,
      });
    });
  }

  async function splitRowsByDate(rows, options = {}) {
    const sourceRows = Array.isArray(rows) ? rows : [];
    if (!sourceRows.length) return {};

    const workerCount = PlaybackWorkerPolicy.resolve(options.concurrency || "auto", {
      task: "snapshot_split",
      total: sourceRows.length,
    });

    if (workerCount <= 1 || typeof Worker === "undefined") {
      return splitSync(sourceRows, options);
    }

    try {
      const chunks = chunkRows(sourceRows, workerCount);
      const partials = await Promise.all(chunks.map((chunk) => runWorker(chunk, {
        dateColumn: options.dateColumn || "date",
        dates: options.dates || [],
      })));
      return partials.reduce((merged, partial) => mergeSnapshots(merged, partial), {});
    } catch (err) {
      console.warn("Playback snapshot worker split failed; falling back to sync split", err);
      return splitSync(sourceRows, options);
    }
  }

  return {
    splitRowsByDate,
    splitSync,
  };
})();
