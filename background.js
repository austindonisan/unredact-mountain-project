/*
 * Unredact Mountain Project — background worker
 *
 * Owns the local name database and nothing else. Network fetches happen in the
 * content script, where a request to /updates/... is same-origin and therefore
 * needs no host permission (this matters on Firefox, where MV3 host permissions
 * are optional-by-default and may not be granted).
 *
 * This file is a classic script so it can serve as both a Chrome MV3 service
 * worker and a Firefox MV3 non-persistent background script.
 */

'use strict';

const api = typeof browser !== 'undefined' ? browser : chrome;

/* ------------------------------------------------------------------ *
 * Database
 * ------------------------------------------------------------------ */

const DB_NAME = 'unredact-mp';
const DB_VERSION = 1; // IndexedDB *schema* version — bump only on structural change
const STORE_NAMES = 'names';
const STORE_META = 'meta';

/*
 * DATA_VERSION is the *content* version. Entries are permanent: original route
 * names effectively never change, so there is no TTL. If a future release ever
 * needs to re-verify what it has (parser bug, MP changes the updates page, a
 * bundled pre-crawled DB supersedes user-fetched rows), bump this constant and
 * every entry written by an older version is treated as stale and refetched.
 */
const DATA_VERSION = 1;

/*
 * Tombstones (name === null) record "we asked and got nothing back" so a
 * deleted route or a broken parse costs one request per month rather than one
 * request per page view. Successful entries are never re-fetched.
 */
const MISS_RETRY_MS = 30 * 24 * 60 * 60 * 1000;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAMES)) {
        // Primary key is the Mountain Project object ID. Route and area IDs
        // come from the same global sequence, so one keyspace is safe and a
        // future pre-crawled DB can be merged in row-for-row.
        const store = db.createObjectStore(STORE_NAMES, { keyPath: 'id' });
        store.createIndex('type', 'type', { unique: false });
        store.createIndex('source', 'source', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'k' });
      }
      // Record versions on first creation / upgrade.
      const tx = req.transaction;
      const meta = tx.objectStore(STORE_META);
      meta.put({ k: 'schemaVersion', v: DB_VERSION });
      meta.put({ k: 'dataVersion', v: DATA_VERSION });
      meta.put({ k: 'createdAt', v: Date.now(), _keep: event.oldVersion === 0 });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => { /* another tab is mid-upgrade; onsuccess follows */ };
  });
  return dbPromise;
}

function tx(storeNames, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    out = fn(t);
  }));
}

function reqAsValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Look up a batch of IDs.
 * Returns { hits: {id: name|null}, missing: [id, ...] }
 * An entry present with name === null is a live tombstone: reported as a hit so
 * the caller leaves the placeholder alone without issuing a request.
 */
async function lookup(ids) {
  const hits = {};
  const missing = [];
  const now = Date.now();

  await tx([STORE_NAMES], 'readonly', (t) => {
    const store = t.objectStore(STORE_NAMES);
    for (const id of ids) {
      const r = store.get(id);
      r.onsuccess = () => {
        const row = r.result;
        if (!row || (row.entryVersion || 0) < DATA_VERSION) {
          missing.push(id);
        } else if (row.name === null || row.name === undefined) {
          if (now - (row.fetchedAt || 0) > MISS_RETRY_MS) missing.push(id);
          else hits[id] = null;
        } else {
          hits[id] = row.name;
        }
      };
    }
  });

  return { hits, missing };
}

async function put(entries) {
  if (!entries || !entries.length) return { stored: 0 };
  await tx([STORE_NAMES], 'readwrite', (t) => {
    const store = t.objectStore(STORE_NAMES);
    for (const e of entries) {
      store.put({
        id: e.id,
        type: e.type || 'route',
        name: typeof e.name === 'string' ? e.name : null,
        placeholder: e.placeholder || null,
        source: e.source || 'fetch',
        entryVersion: DATA_VERSION,
        fetchedAt: Date.now()
      });
    }
  });
  return { stored: entries.length };
}

async function stats() {
  const counts = { total: 0, resolved: 0, misses: 0, routes: 0, areas: 0 };
  await tx([STORE_NAMES], 'readonly', (t) => {
    const cursorReq = t.objectStore(STORE_NAMES).openCursor();
    cursorReq.onsuccess = () => {
      const c = cursorReq.result;
      if (!c) return;
      const row = c.value;
      counts.total += 1;
      if (typeof row.name === 'string') counts.resolved += 1; else counts.misses += 1;
      if (row.type === 'area') counts.areas += 1; else counts.routes += 1;
      c.continue();
    };
  });
  return { ...counts, dataVersion: DATA_VERSION, schemaVersion: DB_VERSION };
}

async function clearAll() {
  await tx([STORE_NAMES], 'readwrite', (t) => { t.objectStore(STORE_NAMES).clear(); });
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Cross-tab fetch claims
 * ------------------------------------------------------------------ *
 * Two tabs opening the same unseen area would otherwise each fetch the same
 * updates page. A claim is a short in-memory lease; a denied caller simply
 * skips and picks the name up from the DB on its next poll. Losing this map
 * when the worker unloads is harmless — worst case is one duplicate request.
 */

const CLAIM_TTL_MS = 20000;
const claims = new Map(); // id -> expiry timestamp

function claim(ids) {
  const now = Date.now();
  const granted = [];
  const denied = [];
  for (const id of ids) {
    const held = claims.get(id);
    if (held && held > now) { denied.push(id); continue; }
    claims.set(id, now + CLAIM_TTL_MS);
    granted.push(id);
  }
  // Opportunistic sweep of expired leases.
  if (claims.size > 500) {
    for (const [k, exp] of claims) if (exp <= now) claims.delete(k);
  }
  return { granted, denied };
}

function release(ids) {
  for (const id of ids) claims.delete(id);
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Message routing
 * ------------------------------------------------------------------ */

const handlers = {
  lookup: (msg) => lookup(msg.ids || []),
  put: (msg) => put(msg.entries || []),
  claim: (msg) => claim(msg.ids || []),
  release: (msg) => release(msg.ids || []),
  stats: () => stats(),
  clear: () => clearAll()
};

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && handlers[msg.cmd];
  if (!handler) return false;
  Promise.resolve(handler(msg))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true; // keep the channel open for the async response
});
