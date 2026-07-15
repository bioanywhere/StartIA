// Service-worker orchestrator for the StartIA → LinkedIn extractor.
//
// Storage architecture:
//   - chrome.storage.local  → run state only (cursors, plan, stats, log, the
//     in-run seen-contacts set). Small and frequently rewritten.
//   - IndexedDB (lib/idb.js) → the authoritative record store (all contact
//     rows), keyed for free upsert/dedupe.
//   - SQLite .db in OPFS (lib/sqlite-bridge.js + offscreen + worker) → an
//     automatic, best-effort mirror of every record write. Isolated: if it
//     fails, extraction continues on IndexedDB alone.
//
// Incremental model (unchanged): START runs a read-only PLAN, the user confirms,
// then only pending/new organizations are processed and upserted.

import { DELAYS, MAX_PEOPLE_SCROLLS, DECISION_MAKER_TERMS } from "./lib/config.js";
import { loadState, saveState, freshState, clearState } from "./lib/storage.js";
import { enumerateAllCategories } from "./lib/startia-api.js";
import {
  normalizeUrl,
  normalizeName,
  classifyLinkedin,
  companyPeopleUrl,
  canonicalProfileUrl,
  orgIdentity,
  orgIdentityFromRow,
} from "./lib/normalize.js";
import {
  extractIndividualProfile,
  extractCompanyPeople,
} from "./lib/linkedin-extractors.js";
import { extractProfileFull } from "./lib/enrich-extractor.js";
import {
  rowId,
  putRows,
  allRows,
  deleteByOrgIds,
  clearAll as idbClear,
  count as idbCount,
  distinctContactUrls,
  putEnrichment,
  getEnrichment,
  allEnrichment,
  clearEnrichment,
  putOutreach,
  getOutreach,
  allOutreach,
  clearOutreach,
} from "./lib/idb.js";
import {
  mirrorInit,
  mirrorUpsert,
  mirrorDeleteOrgs,
  mirrorClear,
  mirrorUpdateByUrl,
} from "./lib/sqlite-bridge.js";
import { mergeRecord } from "./lib/export.js";
import { findContactInfo, providerKeyField } from "./lib/providers.js";

// ---------------------------------------------------------------------------
// Runtime state (in-memory) + guards
// ---------------------------------------------------------------------------

let state = null;
let loopRunning = false;
let planning = false;
let controlSignal = null;
let mirrorWarned = false;
let restoreState = null; // { added, replace } while a restore is streaming in

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureState() {
  if (!state) {
    state = await loadState();
    await migrateLegacyResults();
  }
  return state;
}

// One-time migration of records saved by v1 (array in chrome.storage.local)
// into IndexedDB + the SQLite mirror.
async function migrateLegacyResults() {
  if (state.migratedToIdb) return;
  if (Array.isArray(state.results) && state.results.length) {
    const rows = state.results.map((r) => toStoredRow(r));
    try {
      await putRows(rows);
      mirrorUpsert(rows).catch(() => {});
    } catch (e) {
      // Leave migratedToIdb false so it retries next load rather than losing data.
      return;
    }
  }
  state.results = [];
  state.migratedToIdb = true;
  state.datasetCount = await safeCount();
  await saveState(state, { immediate: true });
}

function log(level, msg) {
  const entry = { t: Date.now(), level, msg };
  state.log.push(entry);
  if (state.log.length > 500) state.log.splice(0, state.log.length - 500);
  chrome.runtime.sendMessage({ type: "LOG", entry }).catch(() => {});
}

function pushState({ immediate = false } = {}) {
  saveState(state, { immediate });
  chrome.runtime.sendMessage({ type: "STATE", state: publicState() }).catch(() => {});
}

function publicState() {
  return {
    // Bumped when the plan/picker delivery changes, so the popup can tell
    // whether the running service worker has this code (vs. a stale one that
    // needs an extension reload).
    bgVersion: "picker-wq-1",
    status: state.status,
    mode: state.mode,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    currentTab: state.currentTab,
    currentPage: state.currentPage,
    currentOrg: state.currentOrg,
    stats: state.stats,
    plan: state.plan,
    // The per-org pending list is derived from the actual work queue (the single
    // source of truth) and rides along only while a plan is awaiting
    // confirmation — so it can never be stale or lost to a separate request.
    planItems:
      state.status === "planned"
        ? (state.workQueue || []).map((o) => ({
            id: orgIdentity(o),
            name: o.name,
            category: o.categoryLabel,
            reason: o.__reason || "incomplete",
          }))
        : null,
    resultCount: state.datasetCount || 0,
    logTail: state.log.slice(-40),
  };
}

async function safeCount() {
  try {
    return await idbCount();
  } catch {
    return state.datasetCount || 0;
  }
}
async function refreshDatasetCount() {
  state.datasetCount = await safeCount();
}

// ---------------------------------------------------------------------------
// Backup & restore — protect against accidental data loss.
// ---------------------------------------------------------------------------

// UTF-8-safe base64 (btoa only handles Latin-1).
function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// Write a timestamped JSON snapshot of the whole dataset to
// Downloads/StartIA/backups/ before any destructive action. Returns
// { ok, skipped?, filename?, count?, error? }. When there is nothing stored,
// it resolves ok+skipped so the caller may proceed.
async function autoBackup(reason) {
  try {
    const rows = await allRows();
    if (!rows.length) return { ok: true, skipped: true };
    const payload = JSON.stringify({
      exported_at: new Date().toISOString(),
      backup_reason: reason,
      summary: state.stats,
      records: rows,
    });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `StartIA/backups/startia-backup-${ts}.json`;
    const url = "data:application/json;base64," + toBase64Utf8(payload);
    await new Promise((resolve, reject) => {
      chrome.downloads.download(
        { url, filename, conflictAction: "uniquify", saveAs: false },
        (id) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(id);
        }
      );
    });
    log("success", `Auto-backup saved before ${reason}: ${filename} (${rows.length} records).`);
    return { ok: true, filename, count: rows.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------------------
// Keep-alive + restart recovery
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "startia-heartbeat") {
    ensureState().then(() => {
      if (state.status === "running" && !loopRunning) {
        log("info", "Heartbeat: resuming interrupted extraction.");
        runLoop().catch((e) => log("error", "Loop crashed: " + e.message));
      }
    });
  }
});

function armHeartbeat() {
  chrome.alarms.create("startia-heartbeat", { periodInMinutes: 0.5 });
}
function disarmHeartbeat() {
  chrome.alarms.clear("startia-heartbeat");
}

chrome.runtime.onStartup.addListener(() => {
  ensureState().then(() => {
    if (state.status === "running") {
      armHeartbeat();
      runLoop().catch((e) => log("error", "Loop crashed: " + e.message));
    } else if (state.status === "enumerating" || state.status === "planned") {
      state.status = state.datasetCount ? "done" : "idle";
      state.plan = null;
      pushState({ immediate: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Message API (from popup)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // SQLITE_OP is handled by the offscreen document, not here. Ignoring it
  // prevents the default case from replying "unknown message" and racing the
  // offscreen document's real response.
  if (msg && msg.type === "SQLITE_OP") {
    return;
  }
  (async () => {
    await ensureState();
    switch (msg.type) {
      case "GET_STATE":
        sendResponse({ state: publicState() });
        break;

      case "START":
        await startPlan(!!msg.reprocessAll);
        sendResponse({ ok: true });
        break;

      case "CONFIRM":
        if (state.status === "planned") await confirmAndRun(msg.selectedIds);
        sendResponse({ ok: true });
        break;

      case "CANCEL_PLAN":
        if (state.status === "planned" || state.status === "enumerating") {
          controlSignal = "stop";
          state.status = state.datasetCount ? "done" : "idle";
          state.plan = null;
          state.workQueue = [];
          log("info", "Plan cancelled. No data changed.");
          pushState({ immediate: true });
        }
        sendResponse({ ok: true });
        break;

      case "PAUSE":
        if (state.status === "running") {
          controlSignal = "pause";
          log("info", "Pause requested…");
        }
        sendResponse({ ok: true });
        break;

      case "RESUME":
        if (state.status === "paused") {
          state.status = "running";
          controlSignal = null;
          pushState({ immediate: true });
          armHeartbeat();
          log("info", "Resuming…");
          runLoop().catch((e) => log("error", "Loop crashed: " + e.message));
        }
        sendResponse({ ok: true });
        break;

      case "STOP":
        controlSignal = "stop";
        if (state.status === "paused") finalize("stopped");
        log("info", "Stop requested…");
        sendResponse({ ok: true });
        break;

      case "GET_RESULTS":
        try {
          const results = await mergedRecords();
          sendResponse({ results, stats: state.stats });
        } catch (e) {
          sendResponse({ results: [], stats: state.stats, error: String(e.message || e) });
        }
        break;

      case "GET_MARKETING_CONTACTS":
        try {
          sendResponse({ contacts: await marketingContacts() });
        } catch (e) {
          sendResponse({ contacts: [], error: String(e.message || e) });
        }
        break;

      case "ENRICH_CONTACT":
        try {
          sendResponse(await enrichContact(msg.url));
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;

      case "GET_PERSON": {
        const u = normalizeUrl(msg.url || "");
        sendResponse({
          enrichment: (await getEnrichment(u)) || null,
          outreach: (await getOutreach(u)) || null,
        });
        break;
      }

      case "ENRICH_CONTACT_INFO":
        try {
          sendResponse(await enrichContactInfo(msg.url, msg.provider));
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;

      case "GET_SETTINGS": {
        const obj = await chrome.storage.local.get("startia_settings");
        sendResponse({ settings: obj.startia_settings || { defaultProvider: "apollo" } });
        break;
      }

      case "SET_SETTINGS":
        await chrome.storage.local.set({ startia_settings: msg.settings || {} });
        sendResponse({ ok: true });
        break;

      case "SET_OUTREACH":
        try {
          sendResponse(await setOutreach(msg.url, msg.patch, !!msg.force));
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;

      case "GET_TEMPLATES": {
        const obj = await chrome.storage.local.get("startia_templates");
        sendResponse({ templates: obj.startia_templates || null });
        break;
      }

      case "SET_TEMPLATES":
        await chrome.storage.local.set({ startia_templates: msg.templates || [] });
        sendResponse({ ok: true });
        break;

      case "RESET": {
        // Safety net: snapshot the dataset before wiping. Abort if the backup
        // fails so a misclick can never destroy un-backed-up data.
        const bk = await autoBackup("reset");
        if (bk.ok === false) {
          log("error", "Reset aborted — automatic backup failed. Export manually (Export JSON), then retry. Nothing was deleted.");
          sendResponse({ ok: false, error: bk.error, backupFailed: true });
          break;
        }
        controlSignal = "stop";
        await clearState();
        try {
          await idbClear();
          await clearEnrichment();
          await clearOutreach();
        } catch {
          /* ignore */
        }
        mirrorClear().catch(() => {});
        state = freshState();
        state.migratedToIdb = true;
        disarmHeartbeat();
        pushState({ immediate: true });
        sendResponse({ ok: true, backup: bk.filename || null });
        break;
      }

      case "RESTORE_START": {
        if (state.status === "running" || state.status === "enumerating") {
          sendResponse({ ok: false, error: "busy — pause or finish the current run first" });
          break;
        }
        restoreState = { added: 0, replace: !!msg.replace };
        if (msg.replace) {
          try {
            await idbClear();
          } catch {
            /* ignore */
          }
          mirrorClear().catch(() => {});
          state.seenContacts = {};
        }
        log("info", `Restore started (${msg.replace ? "replace" : "merge"} mode)…`);
        sendResponse({ ok: true });
        break;
      }

      case "RESTORE_ROWS": {
        if (!restoreState) {
          sendResponse({ ok: false, error: "no restore in progress" });
          break;
        }
        try {
          const rows = (msg.rows || []).map((r) => toStoredRow(r));
          await putRows(rows);
          mirrorUpsert(rows).catch(() => {});
          restoreState.added += rows.length;
          sendResponse({ ok: true, added: rows.length });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      }

      case "RESTORE_DONE": {
        const added = restoreState ? restoreState.added : 0;
        restoreState = null;
        await refreshDatasetCount();
        if ((state.status === "idle" || !state.status) && state.datasetCount) state.status = "done";
        log("success", `Restore complete — ${added} record(s) loaded. Dataset now ${state.datasetCount}.`);
        pushState({ immediate: true });
        sendResponse({ ok: true, added, total: state.datasetCount });
        break;
      }

      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true;
});

// ---------------------------------------------------------------------------
// Phase A — Plan (read-only)
// ---------------------------------------------------------------------------

async function startPlan(reprocessAll) {
  if (state.status === "running" || state.status === "enumerating" || planning) return;
  planning = true;
  try {
    state.mode = reprocessAll ? "reprocess_all" : "incremental";
    state.status = "enumerating";
    state.plan = null;
    state.currentTab = "";
    state.currentOrg = "";
    state.currentPage = "Analyzing saved data…";
    controlSignal = null;
    pushState({ immediate: true });
    log("info", `Planning ${reprocessAll ? "full reprocess" : "incremental run"} — enumerating all four tabs…`);

    const master = await enumerateAllCategories((p) => {
      state.currentTab = p.categoryLabel;
      state.currentPage = `Enumerating ${p.categoryLabel}: page ${p.page}/${p.pages} (${p.totalSoFar} orgs)`;
      pushState();
    });
    if (controlSignal === "stop") {
      controlSignal = null;
      return;
    }
    state.workMaster = master;

    const plan = await buildPlan(reprocessAll);
    state.plan = plan;
    state.status = "planned";
    state.currentPage = "";
    log(
      "success",
      `Plan ready: ${plan.toProcess} to process (${plan.newOrgs} new, ` +
        `${plan.missingLinkedin} missing-LinkedIn, ${plan.previousErrors} errors, ` +
        `${plan.authWalls} auth-walls, ${plan.incomplete} incomplete), ${plan.willSkip} skipped.`
    );
    pushState({ immediate: true });
  } catch (e) {
    state.status = state.datasetCount ? "done" : "idle";
    log("error", "Planning failed: " + e.message);
    pushState({ immediate: true });
  } finally {
    planning = false;
  }
}

// Group saved rows (from IndexedDB) by org identity and classify each org.
async function analyzeExisting() {
  const rows = await allRows();
  const rowsById = new Map();
  const contacts = new Set();
  for (const r of rows) {
    const id = r.org_id || orgIdentityFromRow(r);
    if (!rowsById.has(id)) rowsById.set(id, []);
    rowsById.get(id).push(r);
    if (r.contact_linkedin_url) contacts.add(normalizeUrl(r.contact_linkedin_url));
  }
  const reasonById = new Map();
  for (const [id, rs] of rowsById) reasonById.set(id, orgReason(rs));
  return { rowsById, reasonById, existingContacts: contacts.size };
}

function orgReason(rows) {
  const hasOkData = rows.some(
    (r) => r.status === "ok" && (r.contact_full_name || r.contact_linkedin_url)
  );
  if (hasOkData) return "complete";
  const statuses = rows.map((r) => r.status);
  const errors = rows.map((r) => r.error || "");
  if (statuses.includes("error")) return "error";
  if (errors.includes("auth_wall") || statuses.includes("auth_wall")) return "auth_wall";
  if (statuses.includes("no_linkedin")) return "no_linkedin";
  return "incomplete";
}

async function buildPlan(reprocessAll) {
  const { rowsById, reasonById, existingContacts } = await analyzeExisting();
  let completed = 0;
  for (const reason of reasonById.values()) if (reason === "complete") completed++;

  const counts = {
    newOrgs: 0,
    missingLinkedin: 0,
    previousErrors: 0,
    authWalls: 0,
    incomplete: 0,
    willSkip: 0,
  };
  const queue = [];
  const queuedIds = new Set();

  for (const org of state.workMaster) {
    const id = orgIdentity(org);
    if (queuedIds.has(id)) continue;
    const reason = reasonById.get(id);

    if (!reprocessAll && reason === "complete") {
      counts.willSkip++;
      continue;
    }
    // Tag the queued org with its reason so the popup's picker (derived from the
    // work queue in publicState) and the "updated" count can use it directly.
    org.__reason = reason === undefined ? "new" : reason;
    queue.push(org);
    queuedIds.add(id);

    if (reprocessAll) continue;
    if (reason === undefined) counts.newOrgs++;
    else if (reason === "no_linkedin") counts.missingLinkedin++;
    else if (reason === "error") counts.previousErrors++;
    else if (reason === "auth_wall") counts.authWalls++;
    else counts.incomplete++;
  }

  state.workQueue = queue;

  return {
    mode: state.mode,
    existingOrgs: rowsById.size,
    existingContacts,
    completed,
    toProcess: queue.length,
    ...counts,
  };
}

// ---------------------------------------------------------------------------
// Phase B — Confirm
// ---------------------------------------------------------------------------

async function confirmAndRun(selectedIds) {
  const reprocessAll = state.mode === "reprocess_all";

  // Incremental runs may process only a user-selected subset of the pending
  // organizations (e.g. "just the pending Investors"). An undefined selection
  // means "process everything pending".
  if (!reprocessAll && Array.isArray(selectedIds)) {
    const sel = new Set(selectedIds);
    state.workQueue = state.workQueue.filter((o) => sel.has(orgIdentity(o)));
    if (!state.workQueue.length) {
      log("warn", "No pending records were selected — nothing to process.");
      state.status = "planned";
      pushState({ immediate: true });
      return;
    }
  }

  if (reprocessAll) {
    // Snapshot before wiping; abort the reprocess if the backup fails.
    const bk = await autoBackup("reprocess-all");
    if (bk.ok === false) {
      log("error", "Reprocess aborted — automatic backup failed. Export manually (Export JSON), then retry. Nothing was deleted.");
      state.status = "planned";
      pushState({ immediate: true });
      return;
    }
    try {
      await idbClear();
    } catch {
      /* ignore */
    }
    mirrorClear().catch(() => {});
    state.seenContacts = {};
    state.stats.updated = 0;
    log("warn", `Reprocess all: cleared previous dataset. Processing ${state.workQueue.length} organizations.`);
  } else {
    // Upsert: drop stale rows for every pending org we're about to reprocess.
    const queueIds = [...new Set(state.workQueue.map(orgIdentity))];
    try {
      await deleteByOrgIds(queueIds);
    } catch {
      /* ignore */
    }
    mirrorDeleteOrgs(queueIds).catch(() => {});
    // "updated" = pending orgs in this run that already had saved rows (i.e. not
    // brand new), from the reason tagged on each queued org.
    state.stats.updated = state.workQueue.filter((o) => o.__reason && o.__reason !== "new").length;
    await rebuildSeenContacts();
    log(
      "info",
      `Confirmed: processing ${state.workQueue.length} pending org(s), ` +
        `replacing ${state.stats.updated} stale record set(s); ${state.plan.willSkip} completed org(s) preserved.`
    );
  }

  // Warm up + report the SQLite mirror status.
  const mi = await mirrorInit();
  if (mi.ok) log("info", `SQLite (.db) mirror active — ${mi.result?.count ?? 0} rows in OPFS database.`);
  else log("warn", "SQLite mirror unavailable — continuing on IndexedDB only. (" + mi.error + ")");

  state.stats.orgsProcessed = 0;
  state.stats.orgsTotal = state.workQueue.length;
  state.stats.contacts = 0;
  state.stats.duplicates = 0;
  state.stats.errors = 0;
  state.stats.noLinkedin = 0;
  state.stats.skipped = reprocessAll ? 0 : state.plan.willSkip;

  await refreshDatasetCount();
  state.workCursor = 0;
  state.status = "running";
  state.startedAt = Date.now();
  state.finishedAt = null;
  controlSignal = null;
  pushState({ immediate: true });
  armHeartbeat();
  runLoop().catch((e) => log("error", "Loop crashed: " + e.message));
}

async function rebuildSeenContacts() {
  state.seenContacts = {};
  try {
    const urls = await distinctContactUrls();
    for (const u of urls) if (u) state.seenContacts[normalizeUrl(u)] = true;
  } catch {
    /* best-effort; in-run dedupe still applies */
  }
}

// ---------------------------------------------------------------------------
// Phase C — Process the work queue
// ---------------------------------------------------------------------------

async function runLoop() {
  if (loopRunning) return;
  loopRunning = true;
  try {
    const queue = state.workQueue;
    while (state.workCursor < queue.length) {
      if (await handleControl()) return;

      const org = queue[state.workCursor];
      state.currentTab = org.categoryLabel;
      state.currentOrg = org.name;
      state.currentPage = `Org ${state.workCursor + 1}/${queue.length}`;

      try {
        await processOrg(org);
      } catch (e) {
        state.stats.errors++;
        log("error", `Org "${org.name}" failed: ${e.message}`);
        await recordRow(org, { status: "error", error: e.message });
      }

      state.stats.orgsProcessed++;
      state.workCursor++;
      await refreshDatasetCount();
      pushState({ immediate: true });

      await sleep(DELAYS.betweenOrgs);
    }

    finalize("done");
  } finally {
    loopRunning = false;
  }
}

async function handleControl() {
  if (controlSignal === "stop") {
    finalize("stopped");
    controlSignal = null;
    return true;
  }
  if (controlSignal === "pause") {
    state.status = "paused";
    controlSignal = null;
    disarmHeartbeat();
    log("info", "Paused. Progress saved — you can resume anytime.");
    pushState({ immediate: true });
    return true;
  }
  return false;
}

function finalize(reason) {
  state.status = reason === "stopped" ? "idle" : "done";
  state.finishedAt = Date.now();
  disarmHeartbeat();
  const s = state.stats;
  log(
    "success",
    `${reason === "stopped" ? "Stopped" : "Completed"}. ` +
      `Processed ${s.orgsProcessed}, skipped ${s.skipped}, updated ${s.updated}, ` +
      `contacts ${s.contacts}, duplicates ${s.duplicates}, no-LinkedIn ${s.noLinkedin}, errors ${s.errors}.`
  );
  pushState({ immediate: true });
}

// ---------------------------------------------------------------------------
// Per-organization processing
// ---------------------------------------------------------------------------

async function processOrg(org) {
  if (!org.linkedinUrl) {
    state.stats.noLinkedin++;
    log("warn", `"${org.name}" has no LinkedIn URL — recorded and skipped.`);
    await recordRow(org, { status: "no_linkedin", error: "" });
    return;
  }

  const cls = classifyLinkedin(org.linkedinUrl);

  if (cls.type === "search") {
    log("warn", `"${org.name}" LinkedIn URL is a search result — not saved.`);
    await recordRow(org, { status: "skipped_search_url", error: org.linkedinUrl });
    return;
  }

  if (cls.type === "individual") {
    await processIndividual(org, cls);
  } else if (cls.type === "company") {
    await processCompany(org, cls);
  } else {
    log("warn", `"${org.name}" LinkedIn URL not recognized: ${org.linkedinUrl}`);
    await recordRow(org, { status: "unknown_linkedin_url", error: org.linkedinUrl });
  }
}

async function processIndividual(org, cls) {
  const canonical = canonicalProfileUrl(org.linkedinUrl) || cls.url;
  log("info", `"${org.name}": individual profile → ${canonical}`);

  const data = await scrapeInTab(canonical, extractIndividualProfile, []);

  // Only save a LinkedIn URL when the profile was actually read. If the page was
  // an auth wall / 404 / captcha, leave the URL blank and record the reason.
  if (!data || !data.ok) {
    const reason = (data && data.reason) || "name_not_found";
    log("warn", `"${org.name}": profile not captured (${reason}) — URL left blank. Attempted: ${canonical}`);
    await recordRow(org, {
      linkedin_source_type: "Individual",
      contact_full_name: "",
      contact_title: "",
      contact_linkedin_url: "", // blank — we couldn't verify the profile
      contact_location: "",
      status: reason, // captcha | auth_wall | not_found | name_not_found
      error: canonical, // the attempted URL, for reference
    });
    return;
  }

  const contactUrl = normalizeUrl(canonical);
  if (isDuplicateContact(contactUrl)) {
    state.stats.duplicates++;
    log("info", `Duplicate contact skipped: ${contactUrl}`);
    return;
  }
  markContact(contactUrl);

  const name = data.name;
  const title = data.title || "";
  state.stats.contacts++;
  await recordRow(org, {
    linkedin_source_type: "Individual",
    contact_full_name: name,
    contact_title: title,
    contact_linkedin_url: contactUrl,
    contact_location: data.location || "",
    is_decision_maker: isDecisionMaker(title),
    status: "ok",
    error: "",
  });
  log("success", `Saved contact: ${name}${title ? " — " + title : ""} [${contactUrl}]`);
}

async function processCompany(org, cls) {
  const peopleUrl = companyPeopleUrl(org.linkedinUrl);
  const companyUrl = cls.url;
  log("info", `"${org.name}": company page → People: ${peopleUrl}`);

  const data = await scrapeInTab(peopleUrl, extractCompanyPeople, [
    MAX_PEOPLE_SCROLLS,
    DELAYS.scrollStep,
  ]);

  if (!data || data.authWall) {
    log("warn", `"${org.name}": company People page not accessible (auth wall / private).`);
    await recordRow(org, {
      linkedin_source_type: "Company",
      linkedin_company_url: companyUrl,
      status: "company_no_public_people",
      error: data && data.authWall ? "auth_wall" : "no_people_found",
    });
    return;
  }

  let people = (data.people || [])
    .map((p) => ({ ...p, dm: isDecisionMaker(p.title) }))
    .sort((a, b) => Number(b.dm) - Number(a.dm));

  if (!people.length) {
    log("warn", `"${org.name}": no public people visible on People page.`);
    await recordRow(org, {
      linkedin_source_type: "Company",
      linkedin_company_url: companyUrl,
      status: "company_no_public_people",
      error: "",
    });
    return;
  }

  let saved = 0;
  for (const p of people) {
    const contactUrl = p.profileUrl ? normalizeUrl(p.profileUrl) : "";
    if (contactUrl) {
      if (classifyLinkedin(contactUrl).type === "search") continue;
      if (isDuplicateContact(contactUrl)) {
        state.stats.duplicates++;
        continue;
      }
      markContact(contactUrl);
    }
    state.stats.contacts++;
    saved++;
    await recordRow(org, {
      linkedin_source_type: "Company",
      linkedin_company_url: companyUrl,
      contact_full_name: p.name || "",
      contact_title: p.title || "",
      contact_linkedin_url: contactUrl,
      contact_location: p.location || "",
      is_decision_maker: p.dm,
      status: "ok",
      error: "",
    });
  }
  log("success", `"${org.name}": saved ${saved} contact(s) from company People page.`);
}

// ---------------------------------------------------------------------------
// Tab management + injection
// ---------------------------------------------------------------------------

async function scrapeInTab(url, func, args, opts = {}) {
  let tab;
  try {
    // Some pages (LinkedIn profile bodies) only render when the tab is visible.
    // `active:true` briefly focuses the tab so the full DOM renders before we
    // scrape; the tab is closed immediately after.
    tab = await chrome.tabs.create({ url, active: !!opts.active });
  } catch (e) {
    throw new Error("could not open tab: " + e.message);
  }
  try {
    await waitForTabComplete(tab.id, DELAYS.linkedinTabLoad);
    await sleep(DELAYS.afterTabReady);

    // Inject the (synchronous) extractor. Optionally retry a few times while the
    // page is still lazy-rendering, deciding via opts.retryUntil(result). Each
    // executeScript is capped by a hard timeout so a wedged frame can never hang
    // the loop (and thus never leaves the tab open).
    const maxAttempts = opts.retryUntil ? opts.maxAttempts || 8 : 1;
    let result = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      result = await runInjection(tab.id, func, args);
      if (opts.debug) {
        console.log(
          `[scrapeInTab] attempt ${attempt + 1}/${maxAttempts}`,
          result ? { ok: result.ok, reason: result.reason, name: result.name, exp: (result.experience || []).length } : "null"
        );
      }
      if (!opts.retryUntil || opts.retryUntil(result)) break;
      await sleep(opts.retryDelay || 1200);
    }
    return result;
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      /* tab may already be gone */
    }
  }
}

// Run one executeScript with a hard timeout so it can never hang scrapeInTab.
async function runInjection(tabId, func, args) {
  const exec = chrome.scripting
    .executeScript({ target: { tabId }, func, args: args || [] })
    .then((r) => (r && r[0] ? r[0].result : null))
    .catch((e) => {
      console.warn("[scrapeInTab] injection failed:", (e && e.message) || e);
      return null;
    });
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 15000));
  return Promise.race([exec, timeout]);
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (t) => {
      if (!chrome.runtime.lastError && t && t.status === "complete") finish();
    });
    setTimeout(finish, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Records + dedupe helpers
// ---------------------------------------------------------------------------

function isDecisionMaker(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  return DECISION_MAKER_TERMS.some((term) => t.includes(term));
}

function isDuplicateContact(normalizedUrl) {
  return !!(normalizedUrl && state.seenContacts[normalizedUrl]);
}
function markContact(normalizedUrl) {
  if (normalizedUrl) state.seenContacts[normalizedUrl] = true;
}

// Build a fully-formed, keyed record row from an org + field overrides.
function toStoredRow(base) {
  const org_id = base.org_id || orgIdentityFromRow(base);
  const contactKey =
    base.contact_linkedin_url ||
    (base.contact_full_name ? "name:" + normalizeName(base.contact_full_name) : "@org");
  return {
    id: base.id || rowId(org_id, contactKey),
    org_id,
    category: base.category || "",
    org_name: base.org_name || "",
    org_detail_url: base.org_detail_url || "",
    linkedin_source_type: base.linkedin_source_type || "",
    linkedin_company_url: base.linkedin_company_url || "",
    contact_full_name: base.contact_full_name || "",
    contact_title: base.contact_title || "",
    contact_linkedin_url: base.contact_linkedin_url || "",
    contact_location: base.contact_location || "",
    is_decision_maker: !!base.is_decision_maker,
    status: base.status || "",
    error: base.error || "",
    extracted_at: base.extracted_at || new Date().toISOString(),
  };
}

// Persist one record to IndexedDB (authoritative) and mirror to SQLite (best-effort).
async function recordRow(org, fields) {
  const row = toStoredRow({
    org_id: orgIdentity(org),
    category: org.categoryLabel,
    org_name: org.name,
    org_detail_url: org.detailUrl,
    ...fields,
  });
  await putRows([row]);
  mirrorUpsert([row]).then(reportMirror).catch(() => {});
}

// Log the first time a mirror write fails, then stay quiet.
function reportMirror(res) {
  if (res && res.ok === false && !mirrorWarned) {
    mirrorWarned = true;
    log("warn", "SQLite mirror write failed — records are still safe in IndexedDB. (" + res.error + ")");
  }
}

// ---------------------------------------------------------------------------
// LinkedIn Marketing / enrichment
// ---------------------------------------------------------------------------

// All contact records with person-keyed enrichment + outreach merged in by URL.
async function mergedRecords() {
  const [rows, enrichMap, outreachMap] = await Promise.all([
    allRows(),
    idbMap(allEnrichment),
    idbMap(allOutreach),
  ]);
  return rows.map((r) => {
    const url = normalizeUrl(r.contact_linkedin_url || "");
    return mergeRecord(r, url ? enrichMap.get(url) : null, url ? outreachMap.get(url) : null);
  });
}

async function idbMap(getAllFn) {
  const rows = await getAllFn();
  const m = new Map();
  for (const r of rows) if (r && r.url) m.set(r.url, r);
  return m;
}

// One entry per unique person (individual profile URL) for the marketing table.
async function marketingContacts() {
  const [rows, enrichMap, outreachMap] = await Promise.all([
    allRows(),
    idbMap(allEnrichment),
    idbMap(allOutreach),
  ]);
  const byUrl = new Map();
  for (const r of rows) {
    const url = normalizeUrl(r.contact_linkedin_url || "");
    if (!url || classifyLinkedin(url).type !== "individual") continue; // only real people
    if (!byUrl.has(url)) {
      const e = enrichMap.get(url) || {};
      const o = outreachMap.get(url) || {};
      byUrl.set(url, {
        url,
        name: r.contact_full_name || e.name || "",
        title: r.contact_title || e.current_title || "",
        location: r.contact_location || e.location || "",
        category: r.category || "",
        org_name: r.org_name || "",
        orgs: [r.org_name].filter(Boolean),
        enrich_status: e.status || "",
        enriched_at: e.enriched_at || "",
        headline: e.headline || "",
        current_company: e.current_company || "",
        current_title: e.current_title || "",
        experience_count: Array.isArray(e.experience) ? e.experience.length : 0,
        emails: Array.isArray(e.emails) ? e.emails : [],
        phones: Array.isArray(e.phones) ? e.phones : [],
        contact_provider: e.contact_provider || "",
        contact_status: e.contact_status || "",
        contact_history: Array.isArray(e.contact_history) ? e.contact_history : [],
        outreach_status: o.status || "none",
        outreach_channel: o.channel || "",
        outreach_at: o.at || "",
      });
    } else {
      const c = byUrl.get(url);
      if (r.org_name && !c.orgs.includes(r.org_name)) c.orgs.push(r.org_name);
    }
  }
  return [...byUrl.values()];
}

// Open the profile, scrape the full profile, and store enrichment (IDB + SQLite).
async function enrichContact(rawUrl) {
  const url = normalizeUrl(rawUrl || "");
  if (!url || classifyLinkedin(url).type !== "individual") {
    return { ok: false, error: "not an individual profile URL" };
  }
  // Open the profile in the foreground so LinkedIn renders the full body
  // (Experience/Education/Skills only render in a visible tab). Retry while the
  // page is still lazy-rendering (name not yet present).
  const data = await scrapeInTab(url, extractProfileFull, [], {
    active: true,
    debug: true,
    maxAttempts: 8,
    retryDelay: 1200,
    // Stop on a definitive failure, or once we have a name AND some experience.
    // Keep retrying while the name is missing or experience hasn't rendered yet
    // (capped by maxAttempts so a genuinely empty profile still finishes).
    retryUntil: (r) =>
      !!(r && ((r.reason && r.reason !== "name_not_found") || (r.ok && (r.experience || []).length > 0))),
  });
  console.log("[enrich]", url, "->", data ? { ok: data.ok, reason: data.reason, exp: (data.experience || []).length } : "null");
  if (!data || !data.ok) {
    const reason = (data && data.reason) || "name_not_found";
    const rec = { url, status: reason, enriched_at: new Date().toISOString() };
    await putEnrichment(rec);
    mirrorUpdateByUrl(url, sqlEnrichFields(rec)).catch(() => {});
    return { ok: false, reason, enrichment: rec };
  }
  const rec = {
    url,
    status: "ok",
    enriched_at: new Date().toISOString(),
    name: data.name || "",
    headline: data.headline || "",
    about: data.about || "",
    location: data.location || "",
    current_company: data.current_company || "",
    current_title: data.current_title || "",
    photo_url: data.photo_url || "",
    connections: data.connections || "",
    experience: data.experience || [],
    education: data.education || [],
    skills: data.skills || [],
  };
  await putEnrichment(rec);
  mirrorUpdateByUrl(url, sqlEnrichFields(rec)).catch(() => {});
  return { ok: true, enrichment: rec };
}

// Enrich a person's contact info (email/phone) via a provider API, merging the
// results into the person-keyed enrichment record. Records which provider was
// used, both as the latest provider and in a contact_history log.
async function enrichContactInfo(rawUrl, providerId) {
  const url = normalizeUrl(rawUrl || "");
  if (!url) return { ok: false, error: "missing url" };
  const settings = (await chrome.storage.local.get("startia_settings")).startia_settings || {};
  const pid = providerId || settings.defaultProvider || "apollo";
  const keyField = providerKeyField(pid);
  const apiKey = keyField ? settings[keyField] : null;
  if (!apiKey) {
    return { ok: false, status: "no_key", error: `No API key set for ${pid}. Add it in Settings.` };
  }

  const result = await findContactInfo(pid, url, apiKey);
  const existing = (await getEnrichment(url)) || { url };
  const now = new Date().toISOString();
  const history = Array.isArray(existing.contact_history) ? existing.contact_history.slice() : [];
  history.push({
    provider: pid,
    at: now,
    status: result.status,
    emails: (result.emails || []).length,
    phones: (result.phones || []).length,
  });

  const rec = {
    ...existing,
    url,
    emails: mergeContacts(existing.emails, result.emails, pid),
    phones: mergeContacts(existing.phones, result.phones, pid),
    contact_provider: pid,
    contact_fetched_at: now,
    contact_status: result.status,
    contact_history: history,
  };
  await putEnrichment(rec);
  mirrorUpdateByUrl(url, sqlContactFields(rec)).catch(() => {});
  return { ok: !!result.ok, status: result.status, error: result.error, enrichment: rec };
}

// Merge new email/phone objects into existing, de-duped by value, tagging each
// new value with the provider that supplied it.
function mergeContacts(existingArr, newArr, provider) {
  const out = Array.isArray(existingArr) ? existingArr.slice() : [];
  const seen = new Set(out.map((x) => x && x.value));
  for (const x of newArr || []) {
    if (x && x.value && !seen.has(x.value)) {
      seen.add(x.value);
      out.push({ ...x, source: provider });
    }
  }
  return out;
}

function sqlContactFields(rec) {
  return {
    emails: JSON.stringify(rec.emails || []),
    phones: JSON.stringify(rec.phones || []),
    contact_provider: rec.contact_provider || "",
    contact_fetched_at: rec.contact_fetched_at || "",
    contact_status: rec.contact_status || "",
    contact_history: JSON.stringify(rec.contact_history || []),
  };
}

// Flatten enrichment into the SQLite contacts columns (arrays -> JSON strings).
function sqlEnrichFields(rec) {
  return {
    enrich_status: rec.status || "",
    enriched_at: rec.enriched_at || "",
    enrich_headline: rec.headline || "",
    enrich_about: rec.about || "",
    enrich_location: rec.location || "",
    enrich_current_company: rec.current_company || "",
    enrich_current_title: rec.current_title || "",
    enrich_connections: rec.connections || "",
    enrich_photo_url: rec.photo_url || "",
    experience: JSON.stringify(rec.experience || []),
    education: JSON.stringify(rec.education || []),
    skills: JSON.stringify(rec.skills || []),
  };
}

// Update outreach status for a person. Prevents duplicate actions unless forced.
async function setOutreach(rawUrl, patch, force) {
  const url = normalizeUrl(rawUrl || "");
  if (!url) return { ok: false, error: "missing url" };
  const existing = (await getOutreach(url)) || { url, status: "none" };
  const terminal = ["connect_sent", "message_sent", "inmail_sent", "replied"];
  if (!force && patch && patch.status && terminal.includes(existing.status)) {
    return { ok: false, duplicate: true, existing };
  }
  const rec = { ...existing, ...patch, url, at: new Date().toISOString() };
  await putOutreach(rec);
  mirrorUpdateByUrl(url, {
    outreach_status: rec.status || "",
    outreach_channel: rec.channel || "",
    outreach_at: rec.at || "",
    outreach_note: rec.note || "",
  }).catch(() => {});
  return { ok: true, outreach: rec };
}
