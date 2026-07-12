# Vendored SQLite WASM

These files are the official SQLite WebAssembly build, copied verbatim from the
npm package [`@sqlite.org/sqlite-wasm`](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm)
version **3.53.0-build1** (`dist/`):

- `sqlite3.mjs` — ES module loader (renamed from `index.mjs`)
- `sqlite3.wasm` — the SQLite WebAssembly binary
- `sqlite3-opfs-async-proxy.js` — OPFS async proxy (bundled for completeness)

They are bundled locally because the extension's Content-Security-Policy blocks
loading scripts/WASM from any external origin (CDN). The extension uses the
**OPFS SAHPool VFS** (`installOpfsSAHPoolVfs`), which persists a real SQLite
database inside the browser's Origin Private File System and does not require
cross-origin isolation (COOP/COEP).

SQLite is in the public domain. See https://sqlite.org/copyright.html.
To upgrade: `npm pack @sqlite.org/sqlite-wasm`, then copy `dist/index.mjs` →
`sqlite3.mjs`, `dist/sqlite3.wasm`, and `dist/sqlite3-opfs-async-proxy.js` here.
