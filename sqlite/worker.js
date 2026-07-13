// SQLite worker — runs the real SQLite engine (WASM) and persists a genuine
// .db file into the browser's Origin Private File System (OPFS) via the
// SAHPool VFS (no cross-origin isolation required).
//
// This runs as a MODULE WORKER spawned by the offscreen document, because:
//   - OPFS synchronous access handles are only available inside a Worker, and
//   - MV3 service workers cannot spawn Workers or use OPFS directly.
//
// Protocol (postMessage): { id, op, payload } -> { id, ok, result?, error? }

import sqlite3InitModule from "../vendor/sqlite/sqlite3.mjs";

const DB_FILENAME = "/startia.db";

// Column order for the contacts table (matches the record row shape).
const COLS = [
  "id",
  "org_id",
  "category",
  "org_name",
  "org_detail_url",
  "linkedin_source_type",
  "linkedin_company_url",
  "contact_full_name",
  "contact_title",
  "contact_linkedin_url",
  "contact_location",
  "is_decision_maker",
  "status",
  "error",
  "extracted_at",
];

// Enrichment + outreach columns added by the LinkedIn Marketing feature.
// Nested fields (experience/education/skills) are stored as JSON TEXT.
const EXTRA_COLS = [
  "enrich_status",
  "enriched_at",
  "enrich_headline",
  "enrich_about",
  "enrich_location",
  "enrich_current_company",
  "enrich_current_title",
  "enrich_connections",
  "enrich_photo_url",
  "experience",
  "education",
  "skills",
  "emails",
  "phones",
  "contact_provider",
  "contact_fetched_at",
  "contact_status",
  "contact_history",
  "outreach_status",
  "outreach_channel",
  "outreach_at",
  "outreach_note",
];

let sqlite3 = null;
let db = null;
let readyPromise = null;

async function init() {
  sqlite3 = await sqlite3InitModule();
  // SAHPool VFS: persistent OPFS storage without SharedArrayBuffer/COOP/COEP.
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "startia-sahpool" });
  db = new pool.OpfsSAHPoolDb(DB_FILENAME);
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id                    TEXT PRIMARY KEY,
      org_id                TEXT,
      category              TEXT,
      org_name              TEXT,
      org_detail_url        TEXT,
      linkedin_source_type  TEXT,
      linkedin_company_url  TEXT,
      contact_full_name     TEXT,
      contact_title         TEXT,
      contact_linkedin_url  TEXT,
      contact_location      TEXT,
      is_decision_maker     INTEGER,
      status                TEXT,
      error                 TEXT,
      extracted_at          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_org ON contacts(org_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_url ON contacts(contact_linkedin_url);
  `);
  // Add enrichment/outreach columns to a table that may predate them.
  const existingCols = [];
  db.exec({
    sql: "SELECT name FROM pragma_table_info('contacts')",
    rowMode: "array",
    callback: (r) => existingCols.push(r[0]),
  });
  const existing = new Set(existingCols);
  for (const c of EXTRA_COLS) {
    if (!existing.has(c)) {
      try {
        db.exec(`ALTER TABLE contacts ADD COLUMN ${c} TEXT`);
      } catch {
        /* already present / race — ignore */
      }
    }
  }
  return true;
}

function ensureReady() {
  if (!readyPromise) readyPromise = init();
  return readyPromise;
}

const INSERT_SQL =
  `INSERT OR REPLACE INTO contacts (${COLS.join(",")}) ` +
  `VALUES (${COLS.map(() => "?").join(",")})`;

function bindValues(row) {
  return COLS.map((c) => {
    if (c === "is_decision_maker") return row[c] ? 1 : 0;
    const v = row[c];
    return v === undefined || v === null ? null : v;
  });
}

function upsertRows(rows) {
  if (!rows || !rows.length) return 0;
  db.exec("BEGIN");
  try {
    for (const row of rows) db.exec({ sql: INSERT_SQL, bind: bindValues(row) });
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  }
  return rows.length;
}

function deleteByOrgIds(ids) {
  if (!ids || !ids.length) return 0;
  db.exec("BEGIN");
  try {
    for (const id of ids) db.exec({ sql: "DELETE FROM contacts WHERE org_id = ?", bind: [id] });
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  }
  return ids.length;
}

function clearAll() {
  db.exec("DELETE FROM contacts;");
  return true;
}

// Update the given columns on every row whose contact_linkedin_url matches.
function updateByUrl(url, fields) {
  if (!url || !fields) return 0;
  const cols = Object.keys(fields).filter((c) => EXTRA_COLS.includes(c));
  if (!cols.length) return 0;
  const sql =
    "UPDATE contacts SET " + cols.map((c) => c + " = ?").join(", ") + " WHERE contact_linkedin_url = ?";
  db.exec({ sql, bind: [...cols.map((c) => (fields[c] === undefined ? null : fields[c])), url] });
  return cols.length;
}

function countRows() {
  return db.selectValue("SELECT COUNT(*) FROM contacts");
}

// Serialize the whole database to a Uint8Array (a real .db file image).
function exportBytes() {
  return sqlite3.capi.sqlite3_js_db_export(db);
}

async function handle(op, payload) {
  await ensureReady();
  switch (op) {
    case "init":
      return { count: countRows() };
    case "upsert":
      return { upserted: upsertRows(payload.rows) };
    case "deleteOrgs":
      return { orgs: deleteByOrgIds(payload.ids) };
    case "clear":
      return { cleared: clearAll() };
    case "updateByUrl":
      return { updated: updateByUrl(payload.url, payload.fields) };
    case "count":
      return { count: countRows() };
    case "export": {
      const bytes = exportBytes();
      // Transfer the ArrayBuffer to avoid a copy.
      return { __transfer: [bytes.buffer], bytes };
    }
    default:
      throw new Error("unknown sqlite op: " + op);
  }
}

self.onmessage = async (e) => {
  const { id, op, payload } = e.data || {};
  try {
    const result = await handle(op, payload || {});
    const transfer = result && result.__transfer ? result.__transfer : [];
    if (result) delete result.__transfer;
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
