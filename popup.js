// Popup controller: sends commands to the background service worker and
// renders the live state it broadcasts.

import {
  toCsv,
  toSql,
  toJson,
  parseCsvRecords,
  parseSqlRecords,
  parseJsonRecords,
} from "./lib/export.js";

const $ = (id) => document.getElementById(id);

const els = {
  badge: $("status-badge"),
  startControls: $("start-controls"),
  runControls: $("run-controls"),
  start: $("btn-start"),
  reprocess: $("btn-reprocess"),
  pause: $("btn-pause"),
  resume: $("btn-resume"),
  stop: $("btn-stop"),
  csv: $("btn-csv"),
  json: $("btn-json"),
  sql: $("btn-sql"),
  reset: $("btn-reset"),
  restore: $("btn-restore"),
  restoreFile: $("restore-file"),
  restoreStatus: $("restore-status"),
  marketing: $("btn-marketing"),

  planPanel: $("plan-panel"),
  planTitle: $("plan-title"),
  planAnalyzing: $("plan-analyzing"),
  planProgress: $("plan-progress"),
  planGrid: $("plan-grid"),
  confirm: $("btn-confirm"),
  cancel: $("btn-cancel"),
  pExistingOrgs: $("p-existing-orgs"),
  pExistingContacts: $("p-existing-contacts"),
  pSkip: $("p-skip"),
  pNew: $("p-new"),
  pNoLink: $("p-nolink"),
  pErrors: $("p-errors"),
  pAuthwall: $("p-authwall"),
  pIncomplete: $("p-incomplete"),
  pTotal: $("p-total"),
  planSelect: $("plan-select"),
  filterCategory: $("filter-category"),
  filterIssue: $("filter-issue"),
  selAllBtn: $("sel-all-btn"),
  selNoneBtn: $("sel-none-btn"),
  selCount: $("sel-count"),
  planList: $("plan-list"),

  bar: $("bar"),
  progressLabel: $("progress-label"),
  curTab: $("cur-tab"),
  curPage: $("cur-page"),
  curOrg: $("cur-org"),
  sOrgs: $("s-orgs"),
  sSkipped: $("s-skipped"),
  sContacts: $("s-contacts"),
  sDupes: $("s-dupes"),
  sErrors: $("s-errors"),
  log: $("log"),
};

function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra }).catch(() => ({}));
}
const fmtTime = (t) => new Date(t).toLocaleTimeString();

function show(el, visible) {
  el.classList.toggle("hidden", !visible);
}

// ---- Pending-record picker state ---------------------------------------

const ISSUE_LABELS = {
  new: "New",
  no_linkedin: "No LinkedIn",
  error: "Error",
  auth_wall: "Auth wall",
  incomplete: "Incomplete",
};
const ISSUE_ORDER = ["new", "no_linkedin", "error", "auth_wall", "incomplete"];
const CATEGORY_ORDER = ["Startup", "Investor", "Actor", "Lab"];

let planItems = [];
let selectedIds = new Set();
let filterCat = "all";
let filterIssue = "all";
let planLoaded = false;

function render(state) {
  if (!state) return;
  const status = state.status || "idle";
  const mode = state.mode || "incremental";
  els.badge.textContent = status;
  els.badge.className = "badge " + (["running", "paused", "done"].includes(status) ? status : "idle");

  const planning = status === "enumerating" || status === "planned";
  const active = status === "running" || status === "paused";

  // The pending picker is only meaningful during "planned"; reset it otherwise
  // so re-entering the plan reloads a fresh list.
  if (status !== "planned") planLoaded = false;

  // Which control cluster is visible.
  show(els.startControls, !planning && !active);
  show(els.runControls, active);
  show(els.planPanel, planning);

  // Run buttons.
  els.pause.disabled = status !== "running";
  els.resume.disabled = status !== "paused";
  els.stop.disabled = !active;
  els.start.disabled = planning || active;
  els.reprocess.disabled = planning || active;

  // Plan panel.
  if (planning) renderPlan(state, status, mode);

  // Stats.
  const st = state.stats || {};
  els.sOrgs.textContent = st.orgsProcessed || 0;
  els.sSkipped.textContent = st.skipped || 0;
  els.sContacts.textContent = st.contacts || 0;
  els.sDupes.textContent = st.duplicates || 0;
  els.sErrors.textContent = st.errors || 0;

  els.curTab.textContent = state.currentTab || "—";
  els.curPage.textContent = state.currentPage || "—";
  els.curOrg.textContent = state.currentOrg || "—";

  // Progress bar.
  const total = st.orgsTotal || 0;
  const done = st.orgsProcessed || 0;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : active ? 3 : 0;
  els.bar.style.width = pct + "%";

  if (status === "done") {
    els.progressLabel.textContent =
      `✅ Complete — processed ${done}, skipped ${st.skipped || 0}, ` +
      `${st.contacts || 0} contacts, ${st.errors || 0} errors`;
  } else if (status === "enumerating") {
    els.progressLabel.textContent = "Analyzing…";
  } else if (total) {
    els.progressLabel.textContent = `${done} / ${total} to process (${pct}%)`;
  } else if (active) {
    els.progressLabel.textContent = "Working…";
  } else {
    els.progressLabel.textContent = "Not started";
  }

  if (state.logTail) renderLog(state.logTail);
}

function renderPlan(state, status, mode) {
  const analyzing = status === "enumerating";
  const incremental = mode !== "reprocess_all";
  els.planTitle.textContent = analyzing
    ? mode === "reprocess_all"
      ? "Preparing full reprocess…"
      : "Analyzing saved data…"
    : mode === "reprocess_all"
    ? "Reprocess all records"
    : "Pending records to process";
  show(els.planAnalyzing, analyzing);
  show(els.planGrid, !analyzing);
  show(els.planSelect, !analyzing && incremental);
  els.planProgress.textContent = state.currentPage || "Enumerating StartIA tabs…";

  if (analyzing) {
    els.confirm.disabled = true;
    els.confirm.textContent = "✓ Confirm";
  } else if (incremental) {
    // Items are delivered inside the broadcast state (state.planItems) while
    // status is "planned" — no separate request, so nothing to race/lose.
    const items = state.planItems || [];
    const expected = state.plan ? state.plan.toProcess || 0 : 0;
    if (items.length || expected === 0) {
      if (!planLoaded) {
        planItems = items;
        // Start empty so selections build up additively across filters (use
        // "All shown" with the All/Any-issue filters to select everything).
        selectedIds = new Set();
        filterCat = "all";
        filterIssue = "all";
        planLoaded = true;
        buildFilterChips();
        renderSelect();
      } else {
        updateConfirmButton();
      }
    } else {
      // Picker couldn't populate though the plan says there's work to do.
      // Tell the user exactly why, using the background version stamp.
      showPickerProblem(state, expected);
    }
  } else {
    els.confirm.disabled = false;
    els.confirm.textContent = "✓ Confirm and reprocess ALL records";
  }

  const p = state.plan;
  if (p) {
    els.pExistingOrgs.textContent = p.existingOrgs || 0;
    els.pExistingContacts.textContent = p.existingContacts || 0;
    els.pSkip.textContent = p.willSkip || 0;
    els.pNew.textContent = p.newOrgs || 0;
    els.pNoLink.textContent = p.missingLinkedin || 0;
    els.pErrors.textContent = p.previousErrors || 0;
    els.pAuthwall.textContent = p.authWalls || 0;
    els.pIncomplete.textContent = p.incomplete || 0;
    els.pTotal.textContent = p.toProcess || 0;
  }
}

// Shown when status is "planned" and there is work to do, but the picker list
// arrived empty. Distinguishes a stale background from an empty work queue.
function showPickerProblem(state, expected) {
  planLoaded = false;
  els.filterCategory.innerHTML = "";
  els.filterIssue.innerHTML = "";
  els.selCount.textContent = "";
  els.confirm.disabled = true;
  els.confirm.textContent = "✓ Confirm and process pending records";
  els.planList.innerHTML = "";
  const d = document.createElement("div");
  d.className = "plan-empty";
  if (typeof state.bgVersion === "undefined") {
    d.innerHTML =
      `The extension's background is running an <b>older version</b>, so it can't ` +
      `send the ${expected} pending records to this picker.<br><br>` +
      `Fix: open <b>chrome://extensions</b>, click the <b>⟳ reload</b> icon on this ` +
      `extension, then reopen this popup.`;
  } else {
    d.innerHTML =
      `The work queue is empty even though ${expected} records are pending — the ` +
      `saved plan is stale.<br><br>Fix: click <b>Cancel</b>, then <b>Start</b> again to rebuild it.`;
  }
  els.planList.appendChild(d);
}

function buildFilterChips() {
  const inCat = (it) => filterCat === "all" || it.category === filterCat;
  const inIssue = (it) => filterIssue === "all" || it.reason === filterIssue;

  // Faceted counts: each axis counts within the OTHER axis's current selection.
  //  - Category chip counts reflect the selected issue.
  //  - Issue (status) chip counts reflect the selected category.
  const catCounts = {};
  let catTotal = 0;
  const issueCounts = {};
  let issueTotal = 0;
  for (const it of planItems) {
    if (inIssue(it)) {
      catCounts[it.category] = (catCounts[it.category] || 0) + 1;
      catTotal++;
    }
    if (inCat(it)) {
      issueCounts[it.reason] = (issueCounts[it.reason] || 0) + 1;
      issueTotal++;
    }
  }

  els.filterCategory.innerHTML = "";
  els.filterCategory.appendChild(chipEl("All", "all", filterCat === "all", catTotal, "cat"));
  for (const c of CATEGORY_ORDER) {
    // Keep a chip if it has a count OR is the current selection (so it never
    // vanishes under you).
    if (catCounts[c] || filterCat === c)
      els.filterCategory.appendChild(chipEl(c, c, filterCat === c, catCounts[c] || 0, "cat"));
  }

  els.filterIssue.innerHTML = "";
  els.filterIssue.appendChild(chipEl("Any issue", "all", filterIssue === "all", issueTotal, "issue"));
  for (const k of ISSUE_ORDER) {
    if (issueCounts[k] || filterIssue === k)
      els.filterIssue.appendChild(chipEl(ISSUE_LABELS[k], k, filterIssue === k, issueCounts[k] || 0, "issue"));
  }
}

function chipEl(label, value, active, count, kind) {
  const b = document.createElement("button");
  b.className = "chip" + (active ? " active" : "");
  b.innerHTML = escapeHtml(label) + `<span class="n">${count}</span>`;
  b.addEventListener("click", () => {
    if (kind === "cat") filterCat = value;
    else filterIssue = value;
    buildFilterChips();
    renderSelect();
  });
  return b;
}

function visibleItems() {
  return planItems.filter(
    (it) =>
      (filterCat === "all" || it.category === filterCat) &&
      (filterIssue === "all" || it.reason === filterIssue)
  );
}

function renderSelect() {
  const vis = visibleItems();
  els.planList.innerHTML = "";
  if (!vis.length) {
    const d = document.createElement("div");
    d.className = "plan-empty";
    d.textContent = "No pending records match this filter.";
    els.planList.appendChild(d);
  } else {
    const groups = {};
    for (const it of vis) (groups[it.category] = groups[it.category] || []).push(it);
    const cats = [
      ...CATEGORY_ORDER.filter((c) => groups[c]),
      ...Object.keys(groups).filter((c) => !CATEGORY_ORDER.includes(c)),
    ];
    for (const c of cats) {
      const h = document.createElement("div");
      h.className = "plan-group-head";
      h.textContent = `${c} (${groups[c].length})`;
      els.planList.appendChild(h);
      for (const it of groups[c]) els.planList.appendChild(itemRow(it));
    }
  }
  updateSelCount();
}

function itemRow(it) {
  const row = document.createElement("div");
  row.className = "plan-item";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = selectedIds.has(it.id);
  cb.addEventListener("change", () => {
    if (cb.checked) selectedIds.add(it.id);
    else selectedIds.delete(it.id);
    updateSelCount();
  });
  const nm = document.createElement("span");
  nm.className = "nm";
  nm.textContent = it.name;
  nm.title = it.name;
  const badge = document.createElement("span");
  badge.className = "badge-issue " + it.reason;
  badge.textContent = ISSUE_LABELS[it.reason] || it.reason;
  row.append(cb, nm, badge);
  return row;
}

function updateSelCount() {
  els.selCount.textContent = `${selectedIds.size} of ${planItems.length} selected`;
  updateConfirmButton();
}

function updateConfirmButton() {
  els.confirm.disabled = selectedIds.size === 0;
  els.confirm.textContent = `✓ Confirm and process ${selectedIds.size} selected`;
}

function renderLog(entries) {
  els.log.innerHTML = "";
  for (const e of entries) appendLogEl(e);
  els.log.scrollTop = els.log.scrollHeight;
}
function appendLog(entry) {
  appendLogEl(entry);
  els.log.scrollTop = els.log.scrollHeight;
}
function appendLogEl(entry) {
  const div = document.createElement("div");
  div.className = entry.level;
  div.innerHTML = `<span class="time">${fmtTime(entry.t)}</span> ` + escapeHtml(entry.msg);
  els.log.appendChild(div);
}
function escapeHtml(s) {
  return (s || "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

// ---- Export -------------------------------------------------------------

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function exportData(format) {
  const { results, stats } = await send("GET_RESULTS");
  if (!results || !results.length) {
    alert("No results to export yet.");
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  if (format === "csv") {
    download(`startia-linkedin-${stamp}.csv`, toCsv(results), "text/csv;charset=utf-8");
  } else if (format === "sql") {
    download(`startia-linkedin-${stamp}.sql`, toSql(results), "application/sql;charset=utf-8");
  } else {
    download(`startia-linkedin-${stamp}.json`, toJson(results, stats), "application/json");
  }
}

// ---- Restore (import) ---------------------------------------------------

function setRestore(msg, kind) {
  els.restoreStatus.textContent = msg;
  els.restoreStatus.classList.remove("ok", "warn");
  if (kind) els.restoreStatus.classList.add(kind);
}

async function doRestore(records, replace) {
  const start = await send("RESTORE_START", { replace });
  if (!start || !start.ok) {
    setRestore("Restore failed: " + ((start && start.error) || "busy"), "warn");
    return;
  }
  const BATCH = 400;
  let sent = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const rows = records.slice(i, i + BATCH);
    const r = await send("RESTORE_ROWS", { rows });
    if (r && r.ok) sent += r.added || rows.length;
    setRestore(`Restoring… ${Math.min(i + BATCH, records.length)}/${records.length}`, null);
  }
  const done = await send("RESTORE_DONE", {});
  setRestore(`✓ Restored ${(done && done.added) || sent} records. Dataset now ${(done && done.total) || "?"}.`, "ok");
  refresh();
}

async function onRestoreFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const lower = file.name.toLowerCase();
    const records = lower.endsWith(".csv")
      ? parseCsvRecords(text)
      : lower.endsWith(".sql")
      ? parseSqlRecords(text)
      : parseJsonRecords(text);
    if (!records.length) {
      setRestore("No records found in that file.", "warn");
      return;
    }
    if (!confirm(`Restore ${records.length} records from "${file.name}"?`)) return;
    const replace = confirm(
      "Replace the current dataset?\n\nOK = REPLACE (clear current, then load the backup)\nCancel = MERGE (add the backup into the current dataset)"
    );
    setRestore("Restoring…", null);
    await doRestore(records, replace);
  } catch (err) {
    setRestore("Could not read that file: " + (err.message || err), "warn");
  } finally {
    els.restoreFile.value = "";
  }
}

// ---- Wiring -------------------------------------------------------------

els.start.addEventListener("click", () => send("START", { reprocessAll: false }));
els.reprocess.addEventListener("click", () => {
  if (
    confirm(
      "Reprocess ALL records?\n\nThis re-scrapes every organization from scratch. A backup is saved automatically to Downloads/StartIA/backups before the dataset is cleared, so it can be restored later."
    )
  ) {
    send("START", { reprocessAll: true });
  }
});
els.confirm.addEventListener("click", () => {
  // Incremental runs send the chosen subset; reprocess mode has no picker.
  const payload = planLoaded ? { selectedIds: [...selectedIds] } : {};
  send("CONFIRM", payload);
});
els.cancel.addEventListener("click", () => send("CANCEL_PLAN"));
els.selAllBtn.addEventListener("click", () => {
  // Add every record in the CURRENT filtered view to the selection (additive,
  // like ticking each visible checkbox) — previously-selected records are kept.
  for (const it of visibleItems()) selectedIds.add(it.id);
  renderSelect();
});
els.selNoneBtn.addEventListener("click", () => {
  // Remove the currently shown records from the selection (leaves records
  // selected under other filters untouched).
  for (const it of visibleItems()) selectedIds.delete(it.id);
  renderSelect();
});
els.pause.addEventListener("click", () => send("PAUSE"));
els.resume.addEventListener("click", () => send("RESUME"));
els.stop.addEventListener("click", () => send("STOP"));
els.csv.addEventListener("click", () => exportData("csv"));
els.json.addEventListener("click", () => exportData("json"));
els.sql.addEventListener("click", () => exportData("sql"));
els.restore.addEventListener("click", () => els.restoreFile.click());
els.restoreFile.addEventListener("change", onRestoreFile);
els.marketing.addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("app.html") })
);
els.reset.addEventListener("click", async () => {
  if (
    !confirm(
      "Clear all saved progress and results?\n\nA backup is saved automatically to Downloads/StartIA/backups before clearing, so this can be restored later."
    )
  )
    return;
  const r = await send("RESET");
  if (r && r.ok === false && r.backupFailed) {
    alert("Reset was cancelled because the automatic backup failed:\n" + (r.error || "") + "\n\nExport JSON manually, then try again.");
  }
  refresh();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STATE") render(msg.state);
  else if (msg.type === "LOG") appendLog(msg.entry);
});

async function refresh() {
  const res = await send("GET_STATE");
  if (res && res.state) render(res.state);
}

refresh();
