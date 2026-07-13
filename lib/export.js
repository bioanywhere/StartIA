// Shared export / import serialization — the single source of truth for column
// layout across CSV, SQL, JSON, the SQLite mirror, and restore. Used by the
// popup and the full-page app so every format stays in lock-step.
//
// Nested fields (experience/education/skills) are kept as native arrays in JSON
// and IndexedDB, and serialized as JSON strings in CSV and SQL (which are flat),
// so the structure is preserved and round-trips back on restore.

// [key, label, kind?]  kind: "bool" | "json" (default: scalar text)
export const COLUMNS = [
  ["category", "StartIA Category"],
  ["org_name", "Organization Name"],
  ["org_detail_url", "StartIA Detail URL"],
  ["linkedin_source_type", "LinkedIn Source Type"],
  ["linkedin_company_url", "LinkedIn Company URL"],
  ["contact_full_name", "Contact Full Name"],
  ["contact_title", "Contact Title / Headline"],
  ["contact_linkedin_url", "Contact LinkedIn URL"],
  ["contact_location", "Contact Location"],
  ["is_decision_maker", "Decision Maker", "bool"],
  ["status", "Status"],
  ["error", "Error Details"],
  ["extracted_at", "Extracted At"],
  // Enrichment (person-keyed, merged in by profile URL).
  ["enrich_status", "Enrich Status"],
  ["enriched_at", "Enriched At"],
  ["enrich_headline", "Headline"],
  ["enrich_about", "About"],
  ["enrich_location", "Profile Location"],
  ["enrich_current_company", "Current Company"],
  ["enrich_current_title", "Current Title"],
  ["enrich_connections", "Connections"],
  ["enrich_photo_url", "Photo URL"],
  ["experience", "Experience (JSON)", "json"],
  ["education", "Education (JSON)", "json"],
  ["skills", "Skills (JSON)", "json"],
  // Contact info (email / phone via provider API).
  ["emails", "Emails (JSON)", "json"],
  ["phones", "Phones (JSON)", "json"],
  ["contact_provider", "Contact Provider"],
  ["contact_fetched_at", "Contact Fetched At"],
  ["contact_status", "Contact Status"],
  ["contact_history", "Contact History (JSON)", "json"],
  // Outreach (person-keyed).
  ["outreach_status", "Outreach Status"],
  ["outreach_channel", "Outreach Channel"],
  ["outreach_at", "Outreach At"],
  ["outreach_note", "Outreach Note"],
];

const KIND = Object.fromEntries(COLUMNS.map(([k, , kind]) => [k, kind || "text"]));
const LABEL_TO_KEY = Object.fromEntries(COLUMNS.map(([k, l]) => [l, k]));

// Fold a person's enrichment + outreach into a contact record (by profile URL).
export function mergeRecord(record, enrich, outreach) {
  const e = enrich || {};
  const o = outreach || {};
  return {
    ...record,
    enrich_status: e.status || "",
    enriched_at: e.enriched_at || "",
    enrich_headline: e.headline || "",
    enrich_about: e.about || "",
    enrich_location: e.location || "",
    enrich_current_company: e.current_company || "",
    enrich_current_title: e.current_title || "",
    enrich_connections: e.connections || "",
    enrich_photo_url: e.photo_url || "",
    experience: Array.isArray(e.experience) ? e.experience : [],
    education: Array.isArray(e.education) ? e.education : [],
    skills: Array.isArray(e.skills) ? e.skills : [],
    emails: Array.isArray(e.emails) ? e.emails : [],
    phones: Array.isArray(e.phones) ? e.phones : [],
    contact_provider: e.contact_provider || "",
    contact_fetched_at: e.contact_fetched_at || "",
    contact_status: e.contact_status || "",
    contact_history: Array.isArray(e.contact_history) ? e.contact_history : [],
    outreach_status: o.status || "",
    outreach_channel: o.channel || "",
    outreach_at: o.at || "",
    outreach_note: o.note || "",
  };
}

// ---- CSV ------------------------------------------------------------------

function csvCell(record, key) {
  const kind = KIND[key];
  let v = record[key];
  if (kind === "json") v = JSON.stringify(v || []);
  else if (kind === "bool") v = v ? "true" : "false";
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(rows) {
  const esc = (s) => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  const header = COLUMNS.map(([, label]) => esc(label)).join(",");
  const body = rows.map((r) => COLUMNS.map(([key]) => csvCell(r, key)).join(",")).join("\n");
  return header + "\n" + body;
}

// ---- SQL ------------------------------------------------------------------

function sqlLiteral(record, key) {
  const kind = KIND[key];
  if (kind === "bool") return record[key] ? 1 : 0;
  let v = record[key];
  if (kind === "json") v = JSON.stringify(v || []);
  if (v === null || v === undefined || v === "") return "NULL";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

export function toSql(rows) {
  const cols = COLUMNS.map(([k]) => k);
  const colType = (k) => (KIND[k] === "bool" ? " INTEGER" : " TEXT");
  let out = "-- StartIA → LinkedIn export\n-- Generated: " + new Date().toISOString() + "\n\n";
  out +=
    "CREATE TABLE IF NOT EXISTS contacts (\n" +
    cols.map((c) => "  " + c + colType(c)).join(",\n") +
    "\n);\n\nBEGIN TRANSACTION;\n";
  for (const r of rows) {
    out += `INSERT INTO contacts (${cols.join(", ")}) VALUES (${cols.map((c) => sqlLiteral(r, c)).join(", ")});\n`;
  }
  return out + "COMMIT;\n";
}

// ---- JSON -----------------------------------------------------------------

export function toJson(rows, summary) {
  return JSON.stringify(
    { exported_at: new Date().toISOString(), summary: summary || null, records: rows },
    null,
    2
  );
}

// ---- Restore parsers (CSV / SQL / JSON -> records) ------------------------

function coerce(key, raw) {
  const kind = KIND[key];
  if (kind === "bool") return /^(1|true|yes)$/i.test(String(raw));
  if (kind === "json") {
    if (Array.isArray(raw)) return raw;
    try {
      const a = JSON.parse(raw);
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
  }
  return raw;
}

export function parseJsonRecords(text) {
  const j = JSON.parse(text);
  const arr = Array.isArray(j) ? j : j.records || [];
  return arr
    .filter((r) => r && typeof r === "object")
    .map((r) => {
      const out = { ...r };
      for (const [key] of COLUMNS) if (key in out) out[key] = coerce(key, out[key]);
      return out;
    });
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* skip */ }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function parseCsvRecords(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const keys = rows[0].map((h) => LABEL_TO_KEY[h.trim()] || null);
  return rows
    .slice(1)
    .filter((cells) => cells.some((c) => c !== ""))
    .map((cells) => {
      const rec = {};
      cells.forEach((c, i) => {
        if (keys[i]) rec[keys[i]] = coerce(keys[i], c);
      });
      return rec;
    });
}

function parseSqlValues(text, start) {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== "(") return null;
  i++;
  const values = [];
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (text[i] === ")") return { values, end: i + 1 };
    if (text[i] === "'") {
      i++;
      let s = "";
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") { s += "'"; i += 2; continue; }
          i++;
          break;
        }
        s += text[i++];
      }
      values.push(s);
    } else {
      let tok = "";
      while (i < text.length && !/[,)]/.test(text[i])) tok += text[i++];
      tok = tok.trim();
      values.push(/^null$/i.test(tok) ? "" : tok);
    }
  }
  return null;
}

export function parseSqlRecords(text) {
  const records = [];
  const re = /INSERT\s+INTO\s+contacts\s*\(([^)]*)\)\s*VALUES\s*/gi;
  let m;
  while ((m = re.exec(text))) {
    const cols = m[1].split(",").map((s) => s.trim().replace(/^["'`]|["'`]$/g, ""));
    const parsed = parseSqlValues(text, re.lastIndex);
    if (!parsed || parsed.values.length !== cols.length) continue;
    re.lastIndex = parsed.end;
    const rec = {};
    cols.forEach((c, idx) => {
      if (KIND[c] !== undefined) rec[c] = coerce(c, parsed.values[idx]);
    });
    records.push(rec);
  }
  return records;
}
