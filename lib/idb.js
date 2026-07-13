// IndexedDB record store — the authoritative store for extracted contact rows.
// Dependency-free promise wrapper; usable directly from the MV3 service worker.
//
// Schema (object store "contacts"):
//   keyPath: "id"      composite  <org_id> + "#" + <contactKey>
//   index   "org_id"   non-unique  -> fast delete/replace of one org's rows
//   index   "contact_url" non-unique -> distinct-contact counting
//
// Upsert semantics come for free: re-putting a row with the same `id` replaces
// it, and reprocessing an organization first deletes every row on its org_id
// index, then inserts the fresh set.

const DB_NAME = "startia_records";
const DB_VERSION = 2;
const STORE = "contacts";
// Person-keyed stores (keyed by the normalized LinkedIn profile URL) so a
// person's enrichment and outreach state are shared across every org-contact
// row that points at the same profile.
const ENRICH_STORE = "enrichment";
const OUTREACH_STORE = "outreach";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("org_id", "org_id", { unique: false });
        store.createIndex("contact_url", "contact_linkedin_url", { unique: false });
      }
      if (!db.objectStoreNames.contains(ENRICH_STORE)) {
        db.createObjectStore(ENRICH_STORE, { keyPath: "url" });
      }
      if (!db.objectStoreNames.contains(OUTREACH_STORE)) {
        db.createObjectStore(OUTREACH_STORE, { keyPath: "url" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("tx aborted"));
    tx.onerror = () => reject(tx.error);
  });
}
function reqDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Compute a stable primary key for a record row.
 * Contact rows key on the (normalized) contact URL; org-level status rows
 * (no_linkedin / error / no-public-people) key on a per-org sentinel so an org
 * keeps at most one such placeholder.
 */
export function rowId(orgId, contactUrl) {
  return orgId + "#" + (contactUrl && contactUrl.trim() ? contactUrl.trim() : "@org");
}

// Insert or replace many rows (each must already carry `id` and `org_id`).
export async function putRows(rows) {
  if (!rows || !rows.length) return;
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  for (const r of rows) store.put(r);
  await txDone(tx);
}

// Return every stored row.
export async function allRows() {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  return reqDone(tx.objectStore(STORE).getAll());
}

// Delete all rows for a set/array of org identities. Returns count deleted.
export async function deleteByOrgIds(orgIds) {
  const ids = Array.isArray(orgIds) ? orgIds : [...orgIds];
  if (!ids.length) return 0;
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const index = tx.objectStore(STORE).index("org_id");
  const store = tx.objectStore(STORE);
  let deleted = 0;
  await Promise.all(
    ids.map(
      (orgId) =>
        new Promise((resolve, reject) => {
          const cur = index.openKeyCursor(IDBKeyRange.only(orgId));
          cur.onsuccess = () => {
            const c = cur.result;
            if (c) {
              store.delete(c.primaryKey);
              deleted++;
              c.continue();
            } else resolve();
          };
          cur.onerror = () => reject(cur.error);
        })
    )
  );
  await txDone(tx);
  return deleted;
}

export async function clearAll() {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).clear();
  await txDone(tx);
}

export async function count() {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  return reqDone(tx.objectStore(STORE).count());
}

// ---- Person-keyed stores (enrichment / outreach), keyed by profile URL ----

async function putOne(storeName, obj) {
  if (!obj || !obj.url) return;
  const db = await openDb();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).put(obj);
  await txDone(tx);
}
async function getOne(storeName, url) {
  if (!url) return null;
  const db = await openDb();
  const tx = db.transaction(storeName, "readonly");
  return reqDone(tx.objectStore(storeName).get(url));
}
async function getAll(storeName) {
  const db = await openDb();
  const tx = db.transaction(storeName, "readonly");
  return reqDone(tx.objectStore(storeName).getAll());
}
async function clearStore(storeName) {
  const db = await openDb();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).clear();
  await txDone(tx);
}

export const putEnrichment = (o) => putOne(ENRICH_STORE, o);
export const getEnrichment = (url) => getOne(ENRICH_STORE, url);
export const allEnrichment = () => getAll(ENRICH_STORE);
export const clearEnrichment = () => clearStore(ENRICH_STORE);

export const putOutreach = (o) => putOne(OUTREACH_STORE, o);
export const getOutreach = (url) => getOne(OUTREACH_STORE, url);
export const allOutreach = () => getAll(OUTREACH_STORE);
export const clearOutreach = () => clearStore(OUTREACH_STORE);

// Map of url -> object for a person-keyed store (handy for export merges).
export async function mapByUrl(storeName) {
  const rows = await getAll(storeName === "outreach" ? OUTREACH_STORE : ENRICH_STORE);
  const m = new Map();
  for (const r of rows) if (r && r.url) m.set(r.url, r);
  return m;
}

// Set of distinct non-empty contact LinkedIn URLs currently stored.
export async function distinctContactUrls() {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const index = tx.objectStore(STORE).index("contact_url");
  const urls = new Set();
  await new Promise((resolve, reject) => {
    const cur = index.openKeyCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) {
        if (c.key) urls.add(c.key);
        c.continue();
      } else resolve();
    };
    cur.onerror = () => reject(cur.error);
  });
  return urls;
}
