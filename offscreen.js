// Offscreen document: bridges the service worker to the SQLite module worker.
// An MV3 service worker can't use OPFS or spawn workers, so the SQLite mirror
// runs here. The service worker sends { type: "SQLITE_OP", op, payload } and we
// relay it to the worker, returning its response.

const worker = new Worker(chrome.runtime.getURL("sqlite/worker.js"), { type: "module" });

let seq = 0;
const pending = new Map();

worker.onmessage = (e) => {
  const { id, ok, result, error } = e.data || {};
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (ok) p.resolve(result);
  else p.reject(new Error(error || "sqlite worker error"));
};

worker.onerror = (e) => {
  // Fail all in-flight ops if the worker itself crashes (e.g. WASM load error).
  for (const [, p] of pending) p.reject(new Error("sqlite worker crashed: " + (e.message || "")));
  pending.clear();
};

function call(op, payload) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, payload });
    // Safety timeout so a stuck op can't wedge the pipeline forever.
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("sqlite op timed out: " + op));
      }
    }, 30000);
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "SQLITE_OP") {
    call(msg.op, msg.payload || {}).then(
      (result) => sendResponse({ ok: true, result }),
      (err) => sendResponse({ ok: false, error: String(err.message || err) })
    );
    return true;
  }
  return; // not ours
});
