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
import {
  rowId,
  putRows,
  allRows,
  deleteByOrgIds,
  clearAll as idbClear,
  count as idbCount,
  distinctContactUrls,
} from "./lib/idb.js";
import {
  mirrorInit,
  mirrorUpsert,
  mirrorDeleteOrgs,
  mirrorClear,
} from "./lib/sqlite-bridge.js";

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
    status: state.status,
    mode: state.mode,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    currentTab: state.currentTab,
    currentPage: state.currentPage,
    currentOrg: state.currentOrg,
    stats: state.stats,
    plan: state.plan,
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

      case "GET_PLAN_ITEMS":
        sendResponse({ items: state.planItems || [] });
        break;

      case "CANCEL_PLAN":
        if (state.status === "planned" || state.status === "enumerating") {
          controlSignal = "stop";
          state.status = state.datasetCount ? "done" : "idle";
          state.plan = null;
          state.workQueue = [];
          state.planItems = [];
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
          const results = await allRows();
          sendResponse({ results, stats: state.stats });
        } catch (e) {
          sendResponse({ results: [], stats: state.stats, error: String(e.message || e) });
        }
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
  const items = []; // lightweight per-org descriptors for the popup's picker

  for (const org of state.workMaster) {
    const id = orgIdentity(org);
    if (queuedIds.has(id)) continue;
    const reason = reasonById.get(id);

    if (!reprocessAll && reason === "complete") {
      counts.willSkip++;
      continue;
    }
    queue.push(org);
    queuedIds.add(id);
    items.push({ id, name: org.name, category: org.categoryLabel, reason: reason === undefined ? "new" : reason });

    if (reprocessAll) continue;
    if (reason === undefined) counts.newOrgs++;
    else if (reason === "no_linkedin") counts.missingLinkedin++;
    else if (reason === "error") counts.previousErrors++;
    else if (reason === "auth_wall") counts.authWalls++;
    else counts.incomplete++;
  }

  state.workQueue = queue;
  state.planItems = items;

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
    // brand new), computed from the selected subset.
    const reasonById = new Map((state.planItems || []).map((it) => [it.id, it.reason]));
    state.stats.updated = state.workQueue.filter((o) => {
      const r = reasonById.get(orgIdentity(o));
      return r && r !== "new";
    }).length;
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

  if (data && data.authWall) {
    log("warn", `"${org.name}": profile behind auth wall (login to LinkedIn to capture more).`);
  }

  const contactUrl = normalizeUrl(data?.url || canonical);
  if (isDuplicateContact(contactUrl)) {
    state.stats.duplicates++;
    log("info", `Duplicate contact skipped: ${contactUrl}`);
    return;
  }
  markContact(contactUrl);

  const name = data?.name || "";
  const title = data?.title || "";
  state.stats.contacts++;
  await recordRow(org, {
    linkedin_source_type: "Individual",
    contact_full_name: name,
    contact_title: title,
    contact_linkedin_url: contactUrl,
    contact_location: data?.location || "",
    is_decision_maker: isDecisionMaker(title),
    status: data && data.ok ? "ok" : "partial",
    error: data && data.ok ? "" : data?.authWall ? "auth_wall" : "name_not_found",
  });
  log("success", `Saved contact: ${name || "(name unavailable)"}${title ? " — " + title : ""}`);
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

async function scrapeInTab(url, func, args) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (e) {
    throw new Error("could not open tab: " + e.message);
  }
  try {
    await waitForTabComplete(tab.id, DELAYS.linkedinTabLoad);
    await sleep(DELAYS.afterTabReady);
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func,
      args: args || [],
    });
    return injection ? injection.result : null;
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      /* tab may already be gone */
    }
  }
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
