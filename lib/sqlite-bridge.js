// Service-worker → offscreen bridge for the SQLite (.db) mirror.
//
// The mirror is BEST-EFFORT and fully isolated: every call resolves to
// { ok, ... } and never throws, so a WASM/OPFS failure can never interrupt the
// extraction. IndexedDB remains the authoritative record store.

let creating = null;

async function hasOffscreen() {
  try {
    if (chrome.offscreen && chrome.offscreen.hasDocument) {
      return await chrome.offscreen.hasDocument();
    }
  } catch {
    /* fall through */
  }
  try {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return Array.isArray(ctxs) && ctxs.length > 0;
  } catch {
    return false;
  }
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return true;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "Persist a local SQLite (.db) mirror of extracted records via OPFS.",
      })
      .catch(() => {}) // a concurrent call may have already created it
      .finally(() => {
        creating = null;
      });
  }
  await creating;
  return hasOffscreen();
}

// Send one operation to the SQLite worker (via the offscreen document).
async function sqliteOp(op, payload) {
  try {
    const ok = await ensureOffscreen();
    if (!ok) return { ok: false, error: "offscreen unavailable" };
    const resp = await chrome.runtime.sendMessage({ type: "SQLITE_OP", op, payload });
    return resp || { ok: false, error: "no response from sqlite worker" };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Warm up the worker + WASM + DB; returns { ok, count } so the caller can log
// whether the SQLite mirror is active for this run.
export function mirrorInit() {
  return sqliteOp("init", {});
}
export function mirrorUpsert(rows) {
  if (!rows || !rows.length) return Promise.resolve({ ok: true, result: { upserted: 0 } });
  return sqliteOp("upsert", { rows });
}
export function mirrorDeleteOrgs(ids) {
  const arr = Array.isArray(ids) ? ids : [...ids];
  if (!arr.length) return Promise.resolve({ ok: true, result: { orgs: 0 } });
  return sqliteOp("deleteOrgs", { ids: arr });
}
export function mirrorClear() {
  return sqliteOp("clear", {});
}
export function mirrorCount() {
  return sqliteOp("count", {});
}
