# StartIA → LinkedIn Contact Extractor

A Chrome extension (Manifest V3) that walks the entire
[StartIA ecosystem directory](https://startia.com.co/ecosystem) — **Startups,
Investors, Ecosystem Actors, and Labs** — finds each organization's LinkedIn
URL, and extracts the associated LinkedIn contacts (individual profiles or the
company **People** page). Results are deduplicated and exportable as CSV or JSON.

---

## How it works

StartIA's public directory is backed by a JSON API
(`/back/api/organizations/{startups|investors|supports|labs}`) that returns every
organization together with its social links — including the LinkedIn URL. The
extension pages through this API for all four categories, which is exactly
equivalent to visiting **every pagination page of every tab and opening every
organization's detail page**, but far more reliable than scraping asynchronously
rendered HTML.

For each organization's LinkedIn URL:

- **Individual profile** (`/in/…`) → the canonical profile URL is saved and the
  name, headline/title, current company, and location are read from the profile
  page (via schema.org JSON-LD when available, with DOM fallbacks).
- **Company page** (`/company/…`) → the extension navigates to the company's
  **People** page (`/company/<slug>/people/`), scrolls to load the visible
  people, and extracts each person's name, profile URL, and title.
  Decision-makers (Founder, Co-founder, CEO, President, Managing Director,
  Partner, General Manager, CTO, COO, Head/Director, …) are prioritized.

LinkedIn tabs are opened **in the background** (they never steal focus) and are
closed as soon as they've been read. Only content that is **publicly visible to
your logged-in LinkedIn session** is collected — the extension never logs in,
clicks connect, or bypasses an auth wall.

## Data collected

One record per contact, with these fields:

| Field | Description |
| --- | --- |
| `category` | Startup, Investor, Actor, or Lab |
| `org_name` | Organization name |
| `org_detail_url` | StartIA organization detail URL |
| `linkedin_source_type` | `Individual` or `Company` |
| `linkedin_company_url` | LinkedIn company URL (company case) |
| `contact_full_name` | Contact full name |
| `contact_title` | Contact job title / headline |
| `contact_linkedin_url` | Contact LinkedIn profile URL (normalized, canonical) |
| `contact_location` | Contact location, when available |
| `is_decision_maker` | Heuristic flag for prioritized roles |
| `status` | `ok`, `partial`, `no_linkedin`, `company_no_public_people`, `skipped_search_url`, `error`, … |
| `error` | Error details, when applicable |
| `extracted_at` | ISO timestamp |

Search-result URLs are never saved. Contacts are deduplicated by their
**normalized** LinkedIn profile URL (tracking parameters such as `utm_*`, `trk`,
and `originalSubdomain` are stripped, and trailing slashes removed).

## Installation

1. Download / clone this folder so you have `manifest.json` at its root.
2. Open **`chrome://extensions`** in Chrome (or any Chromium browser).
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select this project folder
   (`C:\Users\agarc\StartIA2`).
5. The **StartIA → LinkedIn Extractor** icon appears in the toolbar. Pin it for
   convenience.

> **Tip:** Log in to LinkedIn in the same Chrome profile first. The extension
> reuses your existing session and only reads what that session can already see.

## Usage

1. Click the extension icon to open the popup.
2. Click **▶ Start Extraction**. The extension first runs a **read-only analysis**
   — it enumerates all four tabs via the API (no LinkedIn tabs open yet), compares
   the ecosystem against your saved data, and shows a **confirmation summary**:
   - Existing organizations & contacts already saved
   - Completed organizations that will be **skipped**
   - New companies, plus records with missing LinkedIn URLs, previous errors,
     auth-wall blocks, and incomplete records that will be **retried**
   - Total to process this run
3. Review the summary and click **✓ Confirm and process pending records** to begin
   scraping — or **Cancel** to change nothing. Only after you confirm does the
   extension open LinkedIn tabs.
4. Use **⏸ Pause**, **⏵ Resume**, and **⏹ Stop** at any time. Progress is saved
   continuously, so you can also close the browser and reopen it — the run
   resumes automatically from where it left off.
5. When finished, the popup shows a **completion summary**. Click
   **⬇ Export CSV** or **⬇ Export JSON** to download the consolidated results
   (previous + new records).
6. **Reset** clears all saved progress and results.

### Incremental runs (the default)

Every **Start** is incremental: it **preserves your existing dataset** and only
adds new organizations or refreshes records that weren't completed. An
organization is **skipped** only if it previously finished successfully *with real
contact data*. Everything else is treated as **pending** and retried:

| Previous outcome | Next run |
| --- | --- |
| Contact saved (`ok` with data) | **Skipped** |
| Not yet seen | Processed (new) |
| `no_linkedin` (missing URL) | Retried |
| `error` | Retried |
| `auth_wall` (login-gated) | Retried |
| `company_no_public_people`, `partial`, search/unknown URL | Retried |

When a pending organization is retried, its old rows are **replaced** (upserted by
organization identity) so the dataset never accumulates duplicate org rows or
stale error records. Contacts remain deduplicated by normalized LinkedIn URL
across the whole dataset.

**Organization identity** is the normalized StartIA detail URL
(`…/detail?slug=<slug>`); if a detail URL is unavailable it falls back to the
normalized organization name + category.

### Reprocess all records

**⟳ Reprocess all records** is the only way to start from scratch. It asks for an
explicit confirmation, then **discards the entire saved dataset** and re-scrapes
every organization. Use it only when you want a clean rebuild.

### Backup & restore (protection against accidental loss)

- **Automatic backup before any wipe.** Both **Reset** and **Reprocess all** first
  write a timestamped snapshot of the whole dataset to
  `Downloads/StartIA/backups/startia-backup-<timestamp>.json`. If that backup
  can't be written, the destructive action is **aborted** — so a misclick can
  never destroy un-backed-up data.
- **Restore from backup.** **↺ Restore from backup…** loads records back from any
  previously saved JSON *or* CSV file (an auto-backup, or a manual Export). You
  choose **Replace** (clear then load) or **Merge** (add into the current
  dataset); merged/duplicate contacts are deduplicated by normalized profile URL.
  This means you never have to re-scrape after an accidental clear.
- **Manual backup** is simply **Export JSON** — the same format Restore reads.

## Reliability & safeguards

- **Resumable:** full state is persisted to `chrome.storage.local` after every
  organization; a heartbeat alarm and `onStartup` handler auto-resume an
  interrupted run.
- **Fault-tolerant:** a failure on any single organization, page, or profile is
  logged and never stops the overall run.
- **Polite pacing:** deliberate delays between organizations, API pages, and
  scroll steps (configurable in `lib/config.js`).
- **No infinite loops:** pagination ends deterministically using the API's
  reported `total`, with an additional runaway guard.
- **Incremental & idempotent:** Start analyzes the saved dataset first and only
  processes pending/new organizations; completed work is never repeated (unless
  you choose *Reprocess all*). Contacts are deduplicated by normalized profile
  URL, and pending organizations are upserted by identity rather than duplicated.

## Where the data is stored

The extension uses three complementary local stores:

| Store | Holds | Purpose |
| --- | --- | --- |
| `chrome.storage.local` | Run state only — cursors, plan, stats, activity log, in-run dedupe set | Small, resumable control state |
| **IndexedDB** (`startia_records`) | **Every contact record** | Authoritative record store; keyed for instant upsert/dedupe and fast plan analysis |
| **SQLite `.db`** in OPFS (`startia.db`) | A mirror of every record | Real SQLite database, updated automatically on every write |

- **IndexedDB is authoritative.** Records are keyed by organization identity +
  contact URL, so reprocessing an organization cleanly replaces its rows and
  duplicate contacts are impossible.
- **The SQLite mirror is automatic and best-effort.** Every record written to
  IndexedDB is also upserted into a genuine SQLite database file kept in the
  browser's Origin Private File System (OPFS). It runs via an offscreen document
  + Web Worker + the bundled `sqlite-wasm` engine, because an MV3 service worker
  cannot use OPFS or spawn workers itself. If the SQLite engine ever fails to
  load, extraction continues on IndexedDB alone (the activity log will say so).
  No manual export is required — the `.db` stays current as records are saved.
- Data from a previous (v1) install is **migrated into IndexedDB automatically**
  the first time the updated extension loads; nothing is lost.
- **Reset** clears all three stores; **Reprocess all** clears the record stores
  before a full re-scrape.

To get your data out, use **Export CSV / Export JSON**, or **↺ Restore from
backup…** to load it back (see *Backup & restore* above). The extension does not
write a database file to your disk; everything stays inside the extension until
you export.

## Project structure

```
manifest.json                 MV3 manifest (permissions, CSP, offscreen)
background.js                 Service-worker orchestrator (state machine)
popup.html / popup.css / popup.js   Extension UI
offscreen.html / offscreen.js       Offscreen host that runs the SQLite worker
sqlite/
  worker.js                   Module worker: SQLite engine + OPFS (SAHPool) DB
vendor/sqlite/                Vendored @sqlite.org/sqlite-wasm (wasm + loader)
lib/
  config.js                   Categories, timing, decision-maker terms, fields
  normalize.js                URL normalization, LinkedIn + org identity
  storage.js                  Run-state helpers (chrome.storage.local)
  idb.js                      IndexedDB record store (authoritative)
  sqlite-bridge.js            Service-worker → offscreen SQLite mirror bridge
  startia-api.js              StartIA ecosystem API pager + enumerator
  linkedin-extractors.js      Self-contained injected DOM extractors
```

## Notes & limitations

- LinkedIn heavily rate-limits and frequently changes its DOM. The extractors
  are defensive (multiple selector fallbacks + JSON-LD) but LinkedIn may still
  return an auth wall or hide profiles for people you aren't connected to; those
  organizations are recorded with an explanatory status instead of failing.
- The tool only collects information already visible to your logged-in session.
  Use it in accordance with LinkedIn's and StartIA's terms of service and
  applicable data-protection law.
- Tuning: adjust delays and scroll limits in `lib/config.js` if you hit rate
  limits or want faster runs.
- The bundled `sqlite-wasm` binary (~865 KB) makes the extension larger; the
  SQLite mirror is optional in spirit — deleting `sqlite/`, `vendor/`, and the
  `offscreen.*` files plus the `offscreen` permission leaves a fully working
  IndexedDB-only build.
