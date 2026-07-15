// StartIA full-page app: Extraction summary + LinkedIn Marketing manager.
import { toCsv, toSql, toJson } from "./lib/export.js";
import { normalizeUrl } from "./lib/normalize.js";

const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra }).catch(() => ({}));

// ---- Navigation -----------------------------------------------------------

const views = {
  extraction: $("view-extraction"),
  marketing: $("view-marketing"),
  settings: $("view-settings"),
};
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b === btn));
    const v = btn.dataset.view;
    for (const [name, el] of Object.entries(views)) el.classList.toggle("hidden", name !== v);
    if (v === "extraction") loadExtraction();
    if (v === "marketing") loadContacts();
    if (v === "settings") loadSettings();
  });
});

// ---- Settings -------------------------------------------------------------

let settings = { defaultProvider: "apollo" };
async function loadSettings() {
  const res = await send("GET_SETTINGS");
  settings = (res && res.settings) || { defaultProvider: "apollo" };
  $("set-apollo").value = settings.apolloKey || "";
  $("set-contactout").value = settings.contactoutKey || "";
  $("set-default").value = settings.defaultProvider || "apollo";
  syncProviderPicker();
}
$("set-save").addEventListener("click", async () => {
  settings = {
    apolloKey: $("set-apollo").value.trim(),
    contactoutKey: $("set-contactout").value.trim(),
    defaultProvider: $("set-default").value,
  };
  await send("SET_SETTINGS", { settings });
  $("set-status").textContent = "Saved.";
  setTimeout(() => ($("set-status").textContent = ""), 2500);
  syncProviderPicker();
});
function syncProviderPicker() {
  const sel = $("m-provider");
  if (sel && settings.defaultProvider) sel.value = settings.defaultProvider;
}

// ---- Extraction view ------------------------------------------------------

async function loadExtraction() {
  const res = await send("GET_STATE");
  const st = (res && res.state && res.state.stats) || {};
  const total = (res && res.state && res.state.resultCount) || 0;
  $("ds-cards").innerHTML = "";
  const cards = [
    ["Records", total],
    ["Contacts", st.contacts || 0],
    ["Skipped", st.skipped || 0],
    ["Errors", st.errors || 0],
  ];
  for (const [label, val] of cards) {
    const d = document.createElement("div");
    d.className = "card";
    d.innerHTML = `<b>${val}</b><span>${label}</span>`;
    $("ds-cards").appendChild(d);
  }
}

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
  if (!results || !results.length) return toast("No records to export yet.");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  if (format === "csv") download(`startia-linkedin-${stamp}.csv`, toCsv(results), "text/csv;charset=utf-8");
  else if (format === "sql") download(`startia-linkedin-${stamp}.sql`, toSql(results), "application/sql;charset=utf-8");
  else download(`startia-linkedin-${stamp}.json`, toJson(results, stats), "application/json");
}
$("x-csv").addEventListener("click", () => exportData("csv"));
$("x-json").addEventListener("click", () => exportData("json"));
$("x-sql").addEventListener("click", () => exportData("sql"));

// ---- Marketing: data + rendering -----------------------------------------

let contacts = [];
let visibleCache = []; // last-rendered filtered rows (for range-select + bulk)
const selected = new Set(); // selected profile URLs (survives filtering)
let lastIndex = null; // anchor row index for shift-click range
const STATUS_LABEL = {
  none: "Not contacted",
  queued: "Queued",
  connect_sent: "Connect sent",
  message_sent: "Message sent",
  inmail_sent: "InMail sent",
  replied: "Replied",
  skipped: "Skipped",
};

async function loadContacts() {
  $("m-count").textContent = "Loading…";
  const res = await send("GET_MARKETING_CONTACTS");
  contacts = (res && res.contacts) || [];
  // Populate category options.
  const cats = [...new Set(contacts.map((c) => c.category).filter(Boolean))].sort();
  const sel = $("m-category");
  const cur = sel.value;
  sel.innerHTML = '<option value="all">All categories</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join("");
  sel.value = cats.includes(cur) || cur === "all" ? cur : "all";
  $("ds-count").textContent = `${contacts.length} people`;
  renderTable();
}

function visibleContacts() {
  const q = $("m-search").value.trim().toLowerCase();
  const cat = $("m-category").value;
  const status = $("m-status").value;
  const enriched = $("m-enriched").value;
  return contacts.filter((c) => {
    if (cat !== "all" && c.category !== cat) return false;
    if (status !== "all" && (c.outreach_status || "none") !== status) return false;
    if (enriched === "yes" && c.enrich_status !== "ok") return false;
    if (enriched === "no" && c.enrich_status === "ok") return false;
    if (q) {
      const hay = `${c.name} ${c.title} ${c.current_company} ${c.org_name} ${c.headline}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderTable() {
  const rows = visibleContacts();
  visibleCache = rows;
  $("m-count").textContent = `${rows.length} of ${contacts.length}`;
  const body = $("m-body");
  body.innerHTML = "";
  rows.forEach((c, i) => body.appendChild(rowEl(c, i)));
  updateBulkBar();
  syncSelectAll();
}

function rowEl(c, index) {
  const tr = document.createElement("tr");
  const enrichedBadge =
    c.enrich_status === "ok"
      ? `<span class="badge ok">✓ ${c.experience_count || 0} exp</span>`
      : c.enrich_status
      ? `<span class="badge">${esc(c.enrich_status)}</span>`
      : `<span class="badge">—</span>`;
  const st = c.outreach_status || "none";
  tr.innerHTML = `
    <td class="sel"></td>
    <td><a href="${esc(c.url)}" target="_blank" rel="noopener">↗</a></td>
    <td>${esc(c.name || "—")}</td>
    <td title="${esc(c.headline || "")}">${esc(c.current_title || c.title || c.headline || "—")}</td>
    <td>${esc(c.current_company || c.org_name || "—")}</td>
    <td class="cell-contact">${contactCell(c.emails, "mailto")}</td>
    <td class="cell-contact">${contactCell(c.phones, "tel")}</td>
    <td>${esc(c.location || "—")}</td>
    <td>${esc(c.category || "—")}</td>
    <td>${enrichedBadge}</td>
    <td><span class="badge ${st}">${esc(STATUS_LABEL[st] || st)}</span></td>
    <td class="cell-actions"></td>`;
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = selected.has(c.url);
  cb.addEventListener("click", (e) => onRowCheck(e, index));
  tr.querySelector("td.sel").appendChild(cb);
  const actions = tr.querySelector(".cell-actions");
  actions.append(
    btn("👁 View", "ghost", () => openDetail(c)),
    btn("Open", "ghost", () => chrome.tabs.create({ url: c.url })),
    btn(c.enrich_status === "ok" ? "Re-enrich" : "Enrich", "ghost", () => enrich(c, tr)),
    btn("☎ Contacts", "ghost", () => findContacts(c)),
    btn("Connect", "", () => openOutreachModal(c, "connect", null)),
    btn("Message", "", () => openOutreachModal(c, "message", null)),
    btn("InMail", "", () => openOutreachModal(c, "inmail", null))
  );
  return tr;
}

// ---- Selection (single / range / all-filtered) ----------------------------

function onRowCheck(e, index) {
  const checked = e.target.checked;
  if (e.shiftKey && lastIndex !== null) {
    const [a, b] = [Math.min(lastIndex, index), Math.max(lastIndex, index)];
    for (let i = a; i <= b; i++) {
      const u = visibleCache[i].url;
      if (checked) selected.add(u);
      else selected.delete(u);
    }
    renderTable(); // reflect the whole range
  } else {
    const u = visibleCache[index].url;
    if (checked) selected.add(u);
    else selected.delete(u);
    updateBulkBar();
    syncSelectAll();
  }
  lastIndex = index;
}

function syncSelectAll() {
  const cb = $("m-selall");
  const shown = visibleCache.length;
  const sel = visibleCache.filter((c) => selected.has(c.url)).length;
  cb.checked = shown > 0 && sel === shown;
  cb.indeterminate = sel > 0 && sel < shown;
}

function updateBulkBar() {
  const n = selected.size;
  $("bulk-bar").classList.toggle("hidden", n === 0);
  $("bulk-count").textContent = `${n} selected`;
}

function selectedContacts() {
  return contacts.filter((c) => selected.has(c.url));
}

$("m-selall").addEventListener("change", (e) => {
  if (e.target.checked) visibleCache.forEach((c) => selected.add(c.url));
  else visibleCache.forEach((c) => selected.delete(c.url));
  renderTable();
});
$("bulk-clear").addEventListener("click", () => {
  selected.clear();
  lastIndex = null;
  renderTable();
});

// ---- Bulk actions ---------------------------------------------------------

$("bulk-queue").addEventListener("click", async () => {
  const list = selectedContacts();
  if (!list.length) return;
  let n = 0;
  for (const c of list) {
    const res = await send("SET_OUTREACH", { url: c.url, patch: { status: "queued", channel: "" } });
    if (res && res.ok) {
      c.outreach_status = "queued";
      c.outreach_at = res.outreach.at;
      n++;
    }
  }
  renderTable();
  toast(`Queued ${n} contact(s).`);
});

$("bulk-enrich").addEventListener("click", async () => {
  const list = selectedContacts();
  if (!list.length) return;
  if (!confirm(`Enrich ${list.length} contact(s)? This opens their LinkedIn profiles one at a time in the background.`)) return;
  let done = 0;
  for (const c of list) {
    toast(`Enriching ${++done}/${list.length}: ${c.name}…`);
    const res = await send("ENRICH_CONTACT", { url: c.url });
    if (res && res.ok) applyEnrichResult(c, res.enrichment);
    else c.enrich_status = (res && res.reason) || "failed";
    renderTable();
  }
  toast(`Enrichment finished for ${list.length} contact(s).`);
});

$("bulk-contacts").addEventListener("click", async () => {
  const list = selectedContacts();
  if (!list.length) return;
  const provider = currentProvider();
  if (!confirm(`Look up contact info (email/phone) for ${list.length} person(s) via ${provider}? This uses your ${provider} API credits.`)) return;
  let hits = 0;
  let done = 0;
  for (const c of list) {
    toast(`Contacts ${++done}/${list.length}: ${c.name}…`);
    const res = await send("ENRICH_CONTACT_INFO", { url: c.url, provider });
    applyContactResult(c, res);
    if (res && res.ok) hits++;
    if (res && res.status === "no_key") {
      toast(`No API key for ${provider} — add it in Settings.`);
      break;
    }
    renderTable();
  }
  toast(`Contact lookup finished: ${hits}/${list.length} had results.`);
});

$("bulk-csv").addEventListener("click", () => exportSelected("csv"));
$("bulk-json").addEventListener("click", () => exportSelected("json"));
$("bulk-sql").addEventListener("click", () => exportSelected("sql"));

async function exportSelected(format) {
  const urls = new Set(selected);
  if (!urls.size) return;
  const { results } = await send("GET_RESULTS");
  const rows = (results || []).filter((r) => urls.has(normalizeUrl(r.contact_linkedin_url || "")));
  if (!rows.length) return toast("No underlying records for the selected people.");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  if (format === "csv") download(`startia-selected-${stamp}.csv`, toCsv(rows), "text/csv;charset=utf-8");
  else if (format === "sql") download(`startia-selected-${stamp}.sql`, toSql(rows), "application/sql;charset=utf-8");
  else download(`startia-selected-${stamp}.json`, toJson(rows), "application/json");
  toast(`Exported ${rows.length} record(s) for ${urls.size} selected person(s).`);
}

// ---- Guided outreach queue ------------------------------------------------

let outreachQueue = null; // { list, i, channel }
$("bulk-outreach").addEventListener("click", () => {
  const list = selectedContacts();
  if (!list.length) return;
  const channel = $("bulk-channel").value;
  if (!confirm(`Start guided outreach for ${list.length} contact(s) via ${channel}? You'll review and send each one on LinkedIn yourself.`)) return;
  outreachQueue = { list, i: 0, channel };
  nextQueueStep();
});
function nextQueueStep() {
  if (!outreachQueue || outreachQueue.i >= outreachQueue.list.length) {
    const total = outreachQueue ? outreachQueue.list.length : 0;
    outreachQueue = null;
    if (total) toast(`Outreach queue finished (${total}).`);
    return;
  }
  const c = outreachQueue.list[outreachQueue.i];
  openOutreachModal(c, outreachQueue.channel, {
    advance: () => {
      outreachQueue.i++;
      nextQueueStep();
    },
    abort: () => {
      outreachQueue = null;
    },
  });
}
function btn(label, cls, onClick) {
  const b = document.createElement("button");
  b.className = "mini " + cls;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

["m-search", "m-category", "m-status", "m-enriched"].forEach((id) =>
  $(id).addEventListener("input", renderTable)
);
$("m-refresh").addEventListener("click", loadContacts);

// ---- Enrichment -----------------------------------------------------------

async function enrich(c, tr) {
  toast(`Enriching ${c.name}…`);
  const res = await send("ENRICH_CONTACT", { url: c.url });
  console.log("[enrich result]", c.url, res);
  c._debug = res && res.debug;
  if (res && res.ok) {
    applyEnrichResult(c, res.enrichment);
    toast(`Enriched ${c.name} — ${c.experience_count} experience entries.`);
  } else {
    c.enrich_status = (res && res.reason) || "failed";
    toast(`Could not enrich ${c.name}: ${(res && res.reason) || (res && res.error) || "failed"}`);
  }
  renderTable();
  openDetail(c); // show what was captured (incl. diagnostics) for a single enrich
}

// Fold a full enrichment record into the contact row shown in the table.
function applyEnrichResult(c, e) {
  if (!e) return;
  Object.assign(c, {
    enrich_status: e.status || "ok",
    name: e.name || c.name,
    headline: e.headline || c.headline,
    about: e.about || "",
    current_company: e.current_company || c.current_company,
    current_title: e.current_title || c.current_title,
    location: e.location || c.location,
    photo_url: e.photo_url || "",
    connections: e.connections || "",
    experience: e.experience || [],
    education: e.education || [],
    skills: e.skills || [],
    experience_count: (e.experience || []).length,
  });
}

// ---- Contact-info enrichment (email / phone via provider) -----------------

function currentProvider() {
  return $("m-provider").value || settings.defaultProvider || "apollo";
}

function contactCell(arr, scheme) {
  if (!Array.isArray(arr) || !arr.length) return '<span class="more">—</span>';
  const first = arr[0].value;
  const all = arr.map((x) => x.value).join(", ");
  const more = arr.length > 1 ? ` <span class="more">+${arr.length - 1}</span>` : "";
  return `<a href="${esc(scheme + ":" + first)}" title="${esc(all)}">${esc(first)}</a>${more}`;
}

function applyContactResult(c, res) {
  if (res && res.enrichment) {
    c.emails = res.enrichment.emails || [];
    c.phones = res.enrichment.phones || [];
    c.contact_provider = res.enrichment.contact_provider || "";
    c.contact_status = res.enrichment.contact_status || "";
  }
}

async function findContacts(c) {
  const provider = currentProvider();
  toast(`Looking up ${c.name} via ${provider}…`);
  const res = await send("ENRICH_CONTACT_INFO", { url: c.url, provider });
  applyContactResult(c, res);
  renderTable();
  if (detailUrl === c.url) openDetail(c);
  if (res && res.ok) {
    toast(`${c.name}: ${(c.emails || []).length} email(s), ${(c.phones || []).length} phone(s) via ${provider}.`);
  } else if (res && res.status === "no_key") {
    toast(`No API key for ${provider}. Add it in Settings.`);
  } else {
    toast(`${c.name}: ${(res && res.error) || "no contacts found"}`);
  }
}

// ---- Detail panel (shows everything gathered for a person) ----------------

let detailUrl = null;
$("detail-close").addEventListener("click", () => {
  $("detail-modal").classList.add("hidden");
  detailUrl = null;
});

async function openDetail(c) {
  detailUrl = c.url;
  $("detail-title").textContent = c.name || "Contact";
  $("detail-body").innerHTML = '<p class="detail-empty">Loading…</p>';
  $("detail-modal").classList.remove("hidden");
  const res = await send("GET_PERSON", { url: c.url });
  const e = (res && res.enrichment) || null;
  const o = (res && res.outreach) || null;
  renderDetail(c, e, o);
}

function renderDetail(c, e, o) {
  e = e || {};
  const emails = e.emails || c.emails || [];
  const phones = e.phones || c.phones || [];
  const exp = e.experience || [];
  const edu = e.education || [];
  const skills = e.skills || [];
  const hist = e.contact_history || [];
  const linkList = (arr, scheme) =>
    arr.length
      ? `<div class="detail-links">${arr
          .map((x) => `<a href="${esc(scheme + ":" + x.value)}">${esc(x.value)}${x.source ? ` — ${esc(x.source)}` : ""}${x.type ? ` (${esc(x.type)})` : ""}</a>`)
          .join("")}</div>`
      : '<span class="detail-empty">none</span>';
  const items = (arr, render) =>
    arr.length ? arr.map(render).join("") : '<span class="detail-empty">none captured</span>';

  $("detail-body").innerHTML = `
    <section>
      <div class="kv"><b>Profile</b><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a></div>
      ${e.headline || c.headline ? `<div class="kv"><b>Headline</b>${esc(e.headline || c.headline)}</div>` : ""}
      <div class="kv"><b>Current</b>${esc(e.current_title || c.current_title || "—")} @ ${esc(e.current_company || c.current_company || "—")}</div>
      <div class="kv"><b>Location</b>${esc(e.location || c.location || "—")}</div>
      ${e.connections ? `<div class="kv"><b>Network</b>${esc(e.connections)}</div>` : ""}
    </section>
    <section>
      <h4>Emails</h4>${linkList(emails, "mailto")}
      <h4 style="margin-top:10px">Phones</h4>${linkList(phones, "tel")}
    </section>
    ${e.about ? `<section><h4>About</h4><div>${esc(e.about)}</div></section>` : ""}
    <section>
      <h4>Experience (${exp.length})</h4>
      ${items(exp, (x) => `<div class="detail-item"><div class="t">${esc(x.title || "")}${x.company ? " · " + esc(x.company) : ""}</div><div class="s">${esc([x.date_range, x.location, x.employment_type].filter(Boolean).join(" · "))}</div></div>`)}
    </section>
    <section>
      <h4>Education (${edu.length})</h4>
      ${items(edu, (x) => `<div class="detail-item"><div class="t">${esc(x.school || "")}</div><div class="s">${esc([x.degree, x.field, x.date_range].filter(Boolean).join(" · "))}</div></div>`)}
    </section>
    <section>
      <h4>Skills (${skills.length})</h4>
      ${skills.length ? `<div class="chips">${skills.map((s) => `<span class="chip-sm">${esc(typeof s === "string" ? s : s.name || "")}</span>`).join("")}</div>` : '<span class="detail-empty">none captured</span>'}
    </section>
    <section>
      <h4>Enrichment</h4>
      <div class="kv"><b>Profile enriched</b>${esc(e.enriched_at || "—")}</div>
      <div class="kv"><b>Contact provider</b>${esc(e.contact_provider || "—")}${e.contact_status ? ` (${esc(e.contact_status)})` : ""}</div>
      <div class="kv"><b>Outreach</b>${esc(o && o.status ? o.status : "none")}${o && o.at ? " · " + esc(new Date(o.at).toLocaleString()) : ""}</div>
      ${hist.length ? `<h4 style="margin-top:8px">Lookup history</h4>${hist.map((h) => `<div class="s">${esc(h.provider)} · ${esc(h.at)} · ${esc(h.status)} · ${h.emails || 0}✉ ${h.phones || 0}☎</div>`).join("")}` : ""}
    </section>
    ${
      c._debug
        ? `<section><h4>Scrape diagnostics</h4><pre class="detail-debug">${esc(JSON.stringify(c._debug, null, 2))}</pre></section>`
        : ""
    }`;
}

// ---- Templates ------------------------------------------------------------

let templates = [];
const DEFAULT_TEMPLATES = [
  { id: "t_connect", name: "Connect – default", channel: "connect", body: "Hi {first_name}, I came across your work at {company} and would love to connect." },
  { id: "t_message", name: "Message – default", channel: "message", body: "Hi {first_name}, I saw you're {title} at {company}. I'm reaching out because…" },
];

async function loadTemplates() {
  const res = await send("GET_TEMPLATES");
  templates = (res && res.templates) || DEFAULT_TEMPLATES.slice();
  renderTemplateSelect();
  selectTemplate(templates[0] && templates[0].id);
}
function renderTemplateSelect() {
  $("tpl-select").innerHTML = templates
    .map((t) => `<option value="${esc(t.id)}">${esc(t.name)} · ${t.channel}</option>`)
    .join("");
}
function currentTemplate() {
  return templates.find((t) => t.id === $("tpl-select").value);
}
function selectTemplate(id) {
  if (id) $("tpl-select").value = id;
  const t = currentTemplate();
  if (!t) return;
  $("tpl-name").value = t.name;
  $("tpl-channel").value = t.channel;
  $("tpl-body").value = t.body;
}
$("tpl-select").addEventListener("change", () => selectTemplate());
$("tpl-new").addEventListener("click", () => {
  const t = { id: "t_" + Date.now(), name: "New template", channel: "message", body: "" };
  templates.push(t);
  renderTemplateSelect();
  selectTemplate(t.id);
});
$("tpl-del").addEventListener("click", async () => {
  const t = currentTemplate();
  if (!t) return;
  templates = templates.filter((x) => x.id !== t.id);
  await send("SET_TEMPLATES", { templates });
  renderTemplateSelect();
  selectTemplate(templates[0] && templates[0].id);
});
$("tpl-save").addEventListener("click", async () => {
  const t = currentTemplate();
  if (!t) return;
  t.name = $("tpl-name").value.trim() || "Untitled";
  t.channel = $("tpl-channel").value;
  t.body = $("tpl-body").value;
  await send("SET_TEMPLATES", { templates });
  renderTemplateSelect();
  selectTemplate(t.id);
  toast("Template saved.");
});

function renderTemplate(body, c) {
  const first = (c.name || "").trim().split(/\s+/)[0] || "there";
  return (body || "")
    .replaceAll("{first_name}", first)
    .replaceAll("{name}", c.name || "")
    .replaceAll("{company}", c.current_company || c.org_name || "")
    .replaceAll("{title}", c.title || c.headline || "")
    .replaceAll("{location}", c.location || "");
}

// ---- Outreach action (auto-fill / you send) + duplicate prevention --------

const CHANNEL_SENT = { connect: "connect_sent", message: "message_sent", inmail: "inmail_sent" };

// queueCtx: null for a single row action, or { advance, abort } when driven by
// the guided outreach queue (adds a Skip button and chains to the next contact).
function openOutreachModal(c, channel, queueCtx) {
  const tpl = templates.find((t) => t.channel === channel) || templates[0];
  const message = tpl ? renderTemplate(tpl.body, c) : "";
  const already = ["connect_sent", "message_sent", "inmail_sent", "replied"].includes(c.outreach_status);
  const warn = already
    ? `Already marked "${STATUS_LABEL[c.outreach_status]}"${c.outreach_at ? " on " + new Date(c.outreach_at).toLocaleString() : ""}. Reaching out again?`
    : "";
  const label = channel === "connect" ? "connection note" : channel === "inmail" ? "InMail" : "message";
  const pos = queueCtx ? ` (${outreachQueue.i + 1} of ${outreachQueue.list.length})` : "";
  openModal({
    title: `${c.name} — ${label}${pos}`,
    warn,
    body: `The ${label} below will be copied to your clipboard and ${c.name}'s LinkedIn profile will open. Review, paste, and send it yourself; it's then marked as sent.`,
    message,
    confirmText: already ? "Send again anyway" : "Copy & open LinkedIn",
    onConfirm: async (finalMessage) => {
      try {
        await navigator.clipboard.writeText(finalMessage);
      } catch {
        /* clipboard may be blocked; message still visible to copy */
      }
      chrome.tabs.create({ url: c.url });
      const res = await send("SET_OUTREACH", {
        url: c.url,
        force: already,
        patch: { status: CHANNEL_SENT[channel], channel, note: finalMessage },
      });
      if (res && res.ok) {
        c.outreach_status = res.outreach.status;
        c.outreach_at = res.outreach.at;
        renderTable();
        toast(`${c.name}: copied ${label} & opened LinkedIn. Marked ${STATUS_LABEL[c.outreach_status]}.`);
      }
      if (queueCtx) queueCtx.advance();
    },
    onSkip: queueCtx ? () => queueCtx.advance() : null,
    onCancel: queueCtx ? () => queueCtx.abort() : null,
  });
}

// ---- Modal + toast --------------------------------------------------------

let modalConfirm = null;
let modalSkip = null;
let modalCancel = null;
function openModal({ title, warn, body, message, confirmText, onConfirm, onSkip, onCancel }) {
  $("modal-title").textContent = title;
  const w = $("modal-warn");
  w.textContent = warn || "";
  w.classList.toggle("hidden", !warn);
  $("modal-body").textContent = body || "";
  const msg = $("modal-message");
  msg.value = message || "";
  msg.classList.toggle("hidden", message === undefined);
  $("modal-confirm").textContent = confirmText || "Confirm";
  $("modal-skip").classList.toggle("hidden", !onSkip);
  modalConfirm = onConfirm;
  modalSkip = onSkip || null;
  modalCancel = onCancel || null;
  $("modal").classList.remove("hidden");
}
function closeModal() {
  $("modal").classList.add("hidden");
  modalConfirm = modalSkip = modalCancel = null;
}
$("modal-cancel").addEventListener("click", () => {
  const fn = modalCancel;
  closeModal();
  if (fn) fn();
});
$("modal-skip").addEventListener("click", () => {
  const fn = modalSkip;
  closeModal();
  if (fn) fn();
});
$("modal-confirm").addEventListener("click", async () => {
  const fn = modalConfirm;
  const message = $("modal-message").value;
  closeModal();
  if (fn) await fn(message);
});

let toastTimer = null;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3500);
}

function esc(s) {
  return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---- Init -----------------------------------------------------------------

loadSettings();
loadTemplates();
loadContacts();
