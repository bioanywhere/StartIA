// Thin wrapper around chrome.storage.local for the persisted extractor state.
// Everything the orchestrator needs to resume after a service-worker restart,
// a browser restart, or an extension reload lives in one JSON blob.

import { STORAGE_KEYS } from "./config.js";

export function freshState() {
  return {
    version: 2,
    // idle | enumerating | planned | running | paused | done
    status: "idle",
    mode: "incremental", // incremental | reprocess_all
    startedAt: null,
    finishedAt: null,

    // Incremental work model: a single master queue spanning all categories,
    // built at plan/confirm time and walked by workCursor. Persisting the queue
    // means a resume never has to re-enumerate or re-diff.
    workMaster: [], // every org discovered in the last enumeration
    workQueue: [], // just the orgs that will actually be processed this run
    workCursor: 0, // index into workQueue

    // The pre-start analysis shown to the user before they confirm.
    plan: null, // { existingOrgs, existingContacts, completed, newOrgs, missingLinkedin, previousErrors, authWalls, incomplete, willSkip, toProcess }

    // De-duplication + idempotency.
    seenOrgIds: {}, // legacy (kept for backward-compat); identity index is rebuilt from results
    seenContacts: {}, // normalized contact profile url -> true

    // Live UI fields.
    currentTab: "",
    currentPage: "",
    currentOrg: "",

    // Aggregate stats over the current dataset.
    stats: {
      orgsProcessed: 0, // orgs processed this run
      orgsTotal: 0, // orgs queued to process this run
      contacts: 0, // contacts added this run
      duplicates: 0,
      errors: 0,
      noLinkedin: 0,
      skipped: 0, // orgs skipped because already complete
      updated: 0, // pending orgs whose stale rows were replaced
    },

    // Records now live in IndexedDB (see lib/idb.js). `results` is retained only
    // to migrate datasets saved by v1 of the extension, then emptied.
    results: [],
    migratedToIdb: false,
    datasetCount: 0, // cached IndexedDB row count for the UI

    log: [], // [{ t, level, msg }]
  };
}

// Make an older/partial state object safe to use with the current code by
// filling in any fields added in later versions.
export function ensureShape(state) {
  const base = freshState();
  if (!state || typeof state !== "object") return base;
  // Top-level fields.
  for (const k of Object.keys(base)) {
    if (state[k] === undefined) state[k] = base[k];
  }
  // Nested stats fields.
  state.stats = Object.assign({}, base.stats, state.stats || {});
  // Drop any disk-sync state left over from earlier versions.
  delete state.diskSync;
  if (!Array.isArray(state.results)) state.results = [];
  if (!Array.isArray(state.log)) state.log = [];
  if (!Array.isArray(state.workMaster)) state.workMaster = [];
  if (!Array.isArray(state.workQueue)) state.workQueue = [];
  if (typeof state.seenContacts !== "object" || !state.seenContacts) state.seenContacts = {};
  return state;
}

export async function loadState() {
  const obj = await chrome.storage.local.get(STORAGE_KEYS.state);
  const state = obj[STORAGE_KEYS.state];
  return ensureShape(state && typeof state === "object" ? state : null);
}

// Coalesced writes so a tight processing loop doesn't hammer storage.
let pendingState = null;
let writeTimer = null;

export function saveState(state, { immediate = false } = {}) {
  pendingState = state;
  if (immediate) {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    return flush();
  }
  if (!writeTimer) {
    writeTimer = setTimeout(flush, 400);
  }
  return Promise.resolve();
}

async function flush() {
  writeTimer = null;
  if (!pendingState) return;
  const toWrite = pendingState;
  pendingState = null;
  await chrome.storage.local.set({ [STORAGE_KEYS.state]: toWrite });
}

export async function clearState() {
  await chrome.storage.local.remove(STORAGE_KEYS.state);
}
