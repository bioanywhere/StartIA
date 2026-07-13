// StartIA full-page app: Extraction summary + LinkedIn Marketing manager.
import { toCsv, toSql, toJson } from "./lib/export.js";

const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra }).catch(() => ({}));

// ---- Navigation -----------------------------------------------------------

const views = { extraction: $("view-extraction"), marketing: $("view-marketing") };
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b === btn));
    const v = btn.dataset.view;
    views.extraction.classList.toggle("hidden", v !== "extraction");
    views.marketing.classList.toggle("hidden", v !== "marketing");
    if (v === "extraction") loadExtraction();
    if (v === "marketing") loadContacts();
  });
});

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
  $("m-count").textContent = `${rows.length} of ${contacts.length}`;
  const body = $("m-body");
  body.innerHTML = "";
  for (const c of rows) body.appendChild(rowEl(c));
}

function rowEl(c) {
  const tr = document.createElement("tr");
  const enrichedBadge =
    c.enrich_status === "ok"
      ? `<span class="badge ok">✓ ${c.experience_count || 0} exp</span>`
      : c.enrich_status
      ? `<span class="badge">${esc(c.enrich_status)}</span>`
      : `<span class="badge">—</span>`;
  const st = c.outreach_status || "none";
  tr.innerHTML = `
    <td><a href="${esc(c.url)}" target="_blank" rel="noopener">↗</a></td>
    <td>${esc(c.name || "—")}</td>
    <td title="${esc(c.headline || "")}">${esc(c.title || c.headline || "—")}</td>
    <td>${esc(c.current_company || c.org_name || "—")}</td>
    <td>${esc(c.location || "—")}</td>
    <td>${esc(c.category || "—")}</td>
    <td>${enrichedBadge}</td>
    <td><span class="badge ${st}">${esc(STATUS_LABEL[st] || st)}</span></td>
    <td class="cell-actions"></td>`;
  const actions = tr.querySelector(".cell-actions");
  actions.append(
    btn("Open", "ghost", () => chrome.tabs.create({ url: c.url })),
    btn(c.enrich_status === "ok" ? "Re-enrich" : "Enrich", "ghost", () => enrich(c, tr)),
    btn("Connect", "", () => outreach(c, "connect")),
    btn("Message", "", () => outreach(c, "message")),
    btn("InMail", "", () => outreach(c, "inmail"))
  );
  return tr;
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
  if (res && res.ok) {
    Object.assign(c, {
      enrich_status: "ok",
      headline: res.enrichment.headline,
      current_company: res.enrichment.current_company,
      current_title: res.enrichment.current_title,
      location: res.enrichment.location || c.location,
      experience_count: (res.enrichment.experience || []).length,
    });
    toast(`Enriched ${c.name} — ${c.experience_count} experience entries.`);
  } else {
    c.enrich_status = (res && res.reason) || "failed";
    toast(`Could not enrich ${c.name}: ${(res && res.reason) || (res && res.error) || "failed"}`);
  }
  renderTable();
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

async function outreach(c, channel) {
  const tpl = templates.find((t) => t.channel === channel) || templates[0];
  const message = tpl ? renderTemplate(tpl.body, c) : "";
  const already = ["connect_sent", "message_sent", "inmail_sent", "replied"].includes(c.outreach_status);
  const warn = already
    ? `Already marked "${STATUS_LABEL[c.outreach_status]}"${c.outreach_at ? " on " + new Date(c.outreach_at).toLocaleString() : ""}. Reaching out again?`
    : "";
  const label = channel === "connect" ? "connection note" : channel === "inmail" ? "InMail" : "message";
  openModal({
    title: `${c.name} — ${label}`,
    warn,
    body: `The ${label} below will be copied to your clipboard and ${c.name}'s LinkedIn profile will open. Review, paste, and send it yourself, then it's marked as sent.`,
    message,
    confirmText: already ? "Send again anyway" : "Copy & open LinkedIn",
    onConfirm: async (finalMessage) => {
      try {
        await navigator.clipboard.writeText(finalMessage);
      } catch {
        /* clipboard may be blocked; message still shown */
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
      } else if (res && res.duplicate) {
        toast(`${c.name} already contacted — not changed.`);
      }
    },
  });
}

// ---- Modal + toast --------------------------------------------------------

let modalConfirm = null;
function openModal({ title, warn, body, message, confirmText, onConfirm }) {
  $("modal-title").textContent = title;
  const w = $("modal-warn");
  w.textContent = warn || "";
  w.classList.toggle("hidden", !warn);
  $("modal-body").textContent = body || "";
  const msg = $("modal-message");
  msg.value = message || "";
  msg.classList.toggle("hidden", message === undefined);
  $("modal-confirm").textContent = confirmText || "Confirm";
  modalConfirm = onConfirm;
  $("modal").classList.remove("hidden");
}
function closeModal() {
  $("modal").classList.add("hidden");
  modalConfirm = null;
}
$("modal-cancel").addEventListener("click", closeModal);
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

loadTemplates();
loadContacts();
