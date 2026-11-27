// ============================================================
// Crew Uploads — public field/marketing upload links (mounted by
// server/index.js). Merged Nov 26 2026 from the standalone
// crew-upload service (Miguel's ruling: no separate project — it
// ships inside this site's Render service).
//
// Everybody opens /u/<token> in any browser (no sign-in), picks or
// drops photos, videos and files, and the files land in Backblaze B2
// via its S3-compatible multipart API (server/crew-s3.js). Each token
// is ONE upload stream: the token alone decides where files land —
// the sender chooses nothing.
//
// SPEED FIX (Nov 27 2026): the original flow proxied every chunk
// through this server (browser -> Render -> B2, one 8 MiB chunk at a
// time, files strictly sequential) — two serial hops on a small
// instance, painfully slow on phone uplinks. The page now uploads
// DIRECT to B2: this server only creates the multipart session,
// hands out short-lived presigned part URLs (/u/api/sign-parts), and
// completes the session from B2's own part list (/u/api/complete).
// The browser sends 16 MiB parts, up to 5 in parallel across files.
// The legacy proxied chunk endpoint (/u/api/chunk) is kept as an
// automatic fallback for browsers/networks where direct B2 PUTs fail
// (e.g. bucket CORS not yet allowing the site origin).
// Uploads land pre-sorted under the stream's company prefix +
// purpose subfolder in the crewuploads bucket:
//
//   crewuploads/coastal-pointe-homes/marketing/<uploader> - <file>
//   crewuploads/coastal-pointe-homes/field/<uploader> - <file>
//   crewuploads/montana-equipment/field/<uploader> - <file>
//
// B2 is the single interim store for uploads until Miguel's own rack
// arrives; the crewuploads bucket stays segregated from the DATA
// seller-data bucket (datapatrimoniostaging). Nothing is stored on
// this server; chunks are proxied straight into the B2 multipart
// session, so a dropped connection resumes from B2's confirmed
// offset.
//
// ISOLATION: routes live only under /u/ (page + health) and /u/api/
// (init / sign-parts / complete / abort / chunk / status), so nothing
// here can shadow an existing site route. If the token/B2 env is not configured, the module
// mounts DISABLED — every token behaves exactly like a bad token
// (page 404, API 403) — and it can never take the site down.
//
// HARDENING (Nov 27 2026, merged from Miguel's hardened upload-server
// review): session ownership is asserted on every session route (a
// stream token can only touch its own sessions / its own bucket
// folder), part-number batches are capped at 100, completion validates
// the backend's part list (contiguity, per-part size limits, an ETag on
// every part, parts summing exactly to the declared size) and
// HEAD-verifies the finished object, and API errors are typed
// (400 validation / 403 ownership / 404 unknown session / 502 storage)
// instead of raw 500s carrying backend internals.
//
// STORAGE BACKEND: any S3-compatible store. Since Nov 27 2026 the
// primary target is Amazon S3 (see ops/S3-GO-LIVE.md); Backblaze B2
// remains supported by pointing the same env at it. crew-s3.js reads
// S3_* env first and falls back to the legacy B2_* names.
//
// Config (env) — same names as the standalone service:
//   UPLOAD_COMPANIES    JSON map: token -> { slug, subfolder, label }
//                       slug      = company prefix in the bucket
//                       subfolder = purpose folder under the slug
//                                   (may be "" for the legacy layout)
//                       label     = heading shown on that token's page
//                       Adding a stream = adding one entry. Tokens
//                       are secrets — generate: openssl rand -hex 24
//   UPLOAD_LINK_TOKEN   legacy single-token fallback (Coastal Pointe
//                       Homes, no subfolder) when UPLOAD_COMPANIES
//                       is unset
//   B2_S3_ENDPOINT      e.g. https://s3.us-east-005.backblazeb2.com
//   B2_BUCKET           default "crewuploads"
//   B2_KEY_ID           B2 application key id (server-side only)
//   B2_APPLICATION_KEY  B2 application key secret (server-side only)
//   B2_S3_REGION        optional override (parsed from endpoint)
//   MAX_FILE_BYTES      per-file cap (default 15 GiB)
//   MAX_FILES_PER_SESSION default 200
//
// Differences from the standalone service, by design:
//   - API paths moved /api/* -> /u/api/* (the site's /api/* is taken).
//   - The standalone's dev-token fallback ("dev") is dropped: with no
//     tokens configured the router is disabled, never guessable.
//   - The upload page gets its own Content-Security-Policy header:
//     it is one self-contained file with an inline <script>, which
//     the site's global script-src 'self' would block. Only this
//     route's header is relaxed; the site's policy is untouched.
// ============================================================
const fs = require("fs");
const path = require("path");
const { createStorage, CHUNK_GRANULARITY, MIN_PART_BYTES, DIRECT_PART_BYTES, PRESIGN_EXPIRES_SECONDS } = require("./crew-s3");

const MAX_FILE_BYTES = parseInt(process.env.MAX_FILE_BYTES || String(15 * 1024 * 1024 * 1024), 10);
const MAX_FILES = parseInt(process.env.MAX_FILES_PER_SESSION || "200", 10);
const BLOCKED_EXT = new Set([".exe", ".msi", ".bat", ".cmd", ".sh", ".scr", ".com", ".dll", ".jar", ".app", ".dmg", ".pkg"]);

function loadCompanies(env) {
  if (env.UPLOAD_COMPANIES) {
    const parsed = JSON.parse(env.UPLOAD_COMPANIES);
    const map = new Map();
    for (const [token, c] of Object.entries(parsed)) {
      if (!c || !c.slug || !c.label) throw new Error(`UPLOAD_COMPANIES entry for token "${token.slice(0, 4)}…" needs { slug, subfolder, label }`);
      const subfolder = String(c.subfolder || "").replace(/^\/+|\/+$/g, "");
      if (subfolder.includes("..")) throw new Error(`UPLOAD_COMPANIES entry for token "${token.slice(0, 4)}…": bad subfolder`);
      map.set(token, { slug: c.slug, subfolder, label: c.label });
    }
    if (!map.size) throw new Error("UPLOAD_COMPANIES is empty");
    return map;
  }
  if (env.UPLOAD_LINK_TOKEN) {
    return new Map([[env.UPLOAD_LINK_TOKEN, { slug: "coastal-pointe-homes", subfolder: "", label: "Coastal Pointe Homes" }]]);
  }
  return new Map();
}

function buildState(env) {
  let companies;
  try { companies = loadCompanies(env); }
  catch (e) { console.error("crew-upload: disabled —", e.message); return { enabled: false }; }
  if (!companies.size) { console.warn("crew-upload: disabled — no UPLOAD_COMPANIES / UPLOAD_LINK_TOKEN set"); return { enabled: false }; }
  let storage;
  try { storage = createStorage(env); }
  catch (e) { console.error("crew-upload: disabled —", e.message); return { enabled: false }; }
  // The page CSP connect-src must name every origin the browser will
  // PUT parts to, or the browser blocks the direct path and the page
  // silently degrades to the slow server relay. That is exactly what
  // happened after the Nov 27 S3 flip: this line still read only the
  // legacy B2_S3_ENDPOINT, so connect-src named the old Backblaze
  // origin while every presigned URL pointed at Amazon S3. Mirror
  // crew-s3's rules: the effective endpoint is S3_ENDPOINT first with
  // B2_S3_ENDPOINT as fallback, and on Amazon the bucket moves into
  // the host (virtual-hosted style), so allow both origins.
  const connectOrigins = new Set();
  try {
    const ep = new URL(env.S3_ENDPOINT || env.B2_S3_ENDPOINT);
    connectOrigins.add(ep.origin);
    if (/\.amazonaws\.com$/i.test(ep.hostname) && storage.bucket) {
      connectOrigins.add(`${ep.protocol}//${storage.bucket}.${ep.hostname}`);
    }
  } catch {}
  const endpointOrigin = connectOrigins.size ? [...connectOrigins].join(' ') : null;
  return { enabled: true, companies, transport: storage.transport, mode: storage.mode, bucket: storage.bucket, endpointOrigin };
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

// The site's global express.json() runs before this mount, so a JSON
// body is already parsed into req.body; only read the stream when the
// content type says it was NOT parsed for us.
async function readJsonBody(req) {
  const ct = String(req.headers["content-type"] || "");
  if (ct.includes("application/json")) return req.body || {};
  const buf = await readRaw(req);
  return buf.length ? JSON.parse(buf.toString("utf8")) : {};
}

function sanitizeName(name) {
  const base = String(name || "upload").replace(/[\\/]/g, "_").replace(/[\x00-\x1f]/g, "").trim();
  return base.slice(0, 200) || "upload";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// The upload page is a single self-contained file with inline script
// and styles; it needs its own CSP (see header note). connect-src also
// allows the B2 endpoint origin so the page can PUT parts directly to
// B2 with presigned URLs (the speed fix — see header note).
function pageCsp(endpointOrigin) {
  return [
    "default-src 'self'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self'${endpointOrigin ? ` ${endpointOrigin}` : ""}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

module.exports = function mount(app, { limiter, db } = {}) {
  const state = buildState(process.env);
  const limit = typeof limiter === "function" ? limiter : ((req, res, next) => next());
  const pageTemplate = fs.readFileSync(path.join(__dirname, "crew-upload.html"), "utf8");

  /* ---------- session store: memory cache + Postgres persistence ----------
     Nov 27 2026 rebuild: sessions used to live ONLY in this process's
     memory (a Map), so any restart/deploy/recycle wiped every in-flight
     upload and a mass batch died with it. Sessions are now persisted to
     the crew_upload_sessions table (the B2/S3 multipart uploadId + key
     are all a session is — parts and offsets are always re-derivable
     from the storage backend's own part list). Completion is recorded
     with the object's key/size/ETag, so "did it land?" has a durable
     server-side answer. Without a Postgres pool (local JSON-db runs)
     the store degrades to memory-only, exactly as before. */
  const sessions = new Map(); // id -> { handle, key, size, offset, createdAt, restored?, synced? }
  const completedSessions = new Map(); // id -> { key, size, etag, at } — bounded; lets /status keep answering "complete" after the live session is dropped, in BOTH store modes (the Postgres row does this durably; this covers the memory fallback and the page's confirm-after-upload step)
  let sessionCounter = 0;
  let activeSessions = 0;
  const MAX_ACTIVE_SESSIONS = parseInt(process.env.MAX_ACTIVE_UPLOAD_SESSIONS || "10000", 10);
  const pool = db && db.kind === "postgres" && db.pool ? db.pool : null;
  let storeReady = Promise.resolve();
  if (pool) {
    storeReady = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS crew_upload_sessions (
        id TEXT PRIMARY KEY, key TEXT NOT NULL, upload_id TEXT NOT NULL,
        size BIGINT NOT NULL, uploader TEXT, name TEXT,
        state TEXT NOT NULL DEFAULT 'active', etag TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query(`ALTER TABLE crew_upload_sessions ADD COLUMN IF NOT EXISTS owner TEXT`);
      await pool.query(`DELETE FROM crew_upload_sessions WHERE state = 'complete' AND updated_at < now() - interval '30 days'`);
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM crew_upload_sessions WHERE state = 'active'`);
      activeSessions = rows[0] ? rows[0].n : 0;
    })().catch((e) => { console.error("crew-upload: session store unavailable, memory-only —", e.message); });
  }
  async function storePut(id, sess, meta) {
    sessions.set(id, sess);
    if (!pool) return;
    try {
      await storeReady;
      await pool.query(
        `INSERT INTO crew_upload_sessions (id, key, upload_id, size, uploader, name, state, owner)
         VALUES ($1,$2,$3,$4,$5,$6,'active',$7)
         ON CONFLICT (id) DO UPDATE SET updated_at = now()`,
        [id, sess.key, sess.handle.uploadId, sess.size, meta && meta.uploader || null, meta && meta.name || null, meta && meta.owner || null]);
    } catch (e) { console.error("crew-upload: session persist failed —", e.message); }
  }
  // Returns a session object, { completeRecord } for a finished upload,
  // or null when the id is unknown anywhere.
  async function storeGet(id) {
    if (sessions.has(id)) return sessions.get(id);
    if (completedSessions.has(id)) { const c = completedSessions.get(id); return { completeRecord: { key: c.key, size: c.size, etag: c.etag }, owner: c.owner || null }; }
    if (!pool) return null;
    try {
      await storeReady;
      const { rows } = await pool.query(`SELECT * FROM crew_upload_sessions WHERE id = $1`, [id]);
      if (!rows[0]) return null;
      const r = rows[0];
      if (r.state === "complete") return { completeRecord: { key: r.key, size: Number(r.size), etag: r.etag }, owner: r.owner || null };
      const sess = { handle: { uploadId: r.upload_id, key: r.key, parts: [], received: 0 },
        key: r.key, size: Number(r.size), offset: 0, createdAt: new Date(r.created_at).getTime(), restored: true, synced: false, owner: r.owner || null };
      sessions.set(id, sess);
      return sess;
    } catch (e) { console.error("crew-upload: session load failed —", e.message); return null; }
  }
  async function storeDelete(id) {
    if (sessions.delete(id)) activeSessions = Math.max(0, activeSessions - 1);
    if (!pool) return;
    try { await pool.query(`DELETE FROM crew_upload_sessions WHERE id = $1`, [id]); } catch {}
  }
  async function storeComplete(id, file, size) {
    const sess = sessions.get(id);
    if (sessions.delete(id)) activeSessions = Math.max(0, activeSessions - 1);
    completedSessions.set(id, { key: (file && file.key) || (sess && sess.key) || null, size: size || (sess && sess.size) || 0, etag: file && file.etag ? String(file.etag) : null, at: Date.now(), owner: (sess && sess.owner) || null });
    if (completedSessions.size > 5000) completedSessions.delete(completedSessions.keys().next().value);
    if (!pool) return;
    try {
      await pool.query(`UPDATE crew_upload_sessions SET state = 'complete', etag = $2, updated_at = now() WHERE id = $1`,
        [id, file && file.etag ? String(file.etag) : null]);
    } catch (e) { console.error("crew-upload: completion persist failed —", e.message); }
  }
  // A restored session's handle has empty parts/received; the relay
  // chunk path needs them synced from the backend's own part list
  // before sendChunk can append. (Status and completeDirect already
  // re-list parts themselves.)
  async function syncRestored(sess) {
    if (!sess.restored || sess.synced) return null;
    const r = await state.transport.sessionParts(sess.handle, sess.size);
    sess.synced = true;
    sess.offset = r.offset;
    return r;
  }

  const companyOf = (req) => (state.enabled ? state.companies.get(req.headers["x-upload-token"] || "") : null);

  // HARDENING (Nov 27 2026): session ownership. init stamps each session
  // with the stream that created it; every session route then asserts the
  // caller's stream owns the session before touching it — one stream's
  // token can no longer status / sign / complete / abort another
  // stream's upload (per-client folder ownership, from Miguel's review).
  // Sessions created before this shipped carry no owner stamp; for those
  // the object's key must still fall inside the caller's own stream
  // folder, which is the same boundary enforced by the key layout.
  const ownerOf = (company) => `${company.slug}/${company.subfolder || ""}`;
  const prefixOf = (company) => (company.subfolder ? `${company.slug}/${company.subfolder}/` : `${company.slug}/`);
  function ownedBy(s, company) {
    if (!s) return false;
    if (s.owner) return s.owner === ownerOf(company);
    const key = s.key || (s.completeRecord && s.completeRecord.key) || "";
    return key.startsWith(prefixOf(company));
  }
  const notOwned = (res) => res.status(403).json({ error: "session belongs to a different upload stream" });
  // Typed errors: a validation problem answers with its own httpStatus
  // (400/403/404 set by the thrower); anything else is a storage or
  // service failure and answers a generic 502 — raw backend error text
  // (which can name buckets and request internals) is logged, never sent.
  function sendErr(res, err) {
    const status = err && err.httpStatus ? err.httpStatus : 502;
    if (status >= 500) console.error("crew-upload:", (err && err.message) || err);
    res.status(status).json({ error: status >= 500 ? "storage backend error" : String((err && err.message) || err) });
  }

  app.get("/u/health", (req, res) => res.json({
    ok: true,
    enabled: state.enabled,
    transport: state.enabled ? state.mode : null,
    bucket: state.enabled ? state.bucket : null,
    streams: state.enabled ? [...state.companies.values()].map((c) => ({ slug: c.slug, subfolder: c.subfolder, label: c.label })) : [],
  }));

  // Public page: only reachable under a valid stream token path.
  const page = (req, res) => {
    const company = state.enabled ? state.companies.get(req.params.token) : null;
    if (!company) return res.status(404).json({ error: "not found" });
    res.setHeader("Content-Security-Policy", pageCsp(state.endpointOrigin));
    const html = pageTemplate.split("{{STREAM_LABEL}}").join(escapeHtml(company.label));
    res.type("html").send(html);
  };
  app.get("/u/:token", page);
  app.get("/u/:token/", page);

  // POST /u/api/init { name, size, mimeType, uploader } -> { id, offset: 0 }
  // Rate limits on the crew routes are sized for MASS batches from one
  // IP (a phone uploading 1,500 photos is one IP): the old init cap of
  // 60 per 10 min per IP made every file past #60 fail before it could
  // start — the Nov 27 mass-upload collapse. The stream token remains
  // the real access control.
  app.post("/u/api/init", limit(2000, 10 * 60e3), async (req, res) => {
    try {
      const company = companyOf(req);
      if (!company) return res.status(403).json({ error: "bad token" });
      const body = await readJsonBody(req);
      const name = sanitizeName(body.name);
      const size = Number(body.size);
      if (!Number.isInteger(size) || size <= 0) return res.status(400).json({ error: "invalid size" });
      if (size > MAX_FILE_BYTES) return res.status(413).json({ error: `file too large (max ${MAX_FILE_BYTES} bytes)` });
      const ext = path.extname(name).toLowerCase();
      if (BLOCKED_EXT.has(ext)) return res.status(415).json({ error: "file type not allowed" });
      if (activeSessions >= MAX_ACTIVE_SESSIONS) return res.status(429).json({ error: "too many active sessions" });
      const uploader = sanitizeName(body.uploader || "crew");
      const key = company.subfolder
        ? `${company.slug}/${company.subfolder}/${uploader} - ${name}`
        : `${company.slug}/${uploader} - ${name}`;
      const handle = await state.transport.initSession({ key, size, mimeType: body.mimeType });
      const id = `s${++sessionCounter}-${Date.now().toString(36)}`;
      activeSessions++;
      await storePut(id, { handle, key, size, offset: 0, createdAt: Date.now(), synced: true, owner: ownerOf(company) }, { uploader, name, owner: ownerOf(company) });
      res.json({ id, offset: 0, chunkGranularity: CHUNK_GRANULARITY, partSize: DIRECT_PART_BYTES, direct: true });
    } catch (err) {
      sendErr(res, err);
    }
  });

  // GET /u/api/status/:id -> { offset, complete, partNumbers, partSize, file? }
  // (resume point; partNumbers lets the direct path skip parts already on B2)
  app.get("/u/api/status/:id", limit(4000, 10 * 60e3), async (req, res) => {
    try {
      const company = companyOf(req);
      if (!company) return res.status(403).json({ error: "bad token" });
      const s = await storeGet(req.params.id);
      if (!s) return res.status(404).json({ error: "unknown session" });
      if (!ownedBy(s, company)) return notOwned(res);
      if (s.completeRecord) {
        return res.json({ complete: true, offset: s.completeRecord.size, partNumbers: [], partSize: DIRECT_PART_BYTES, file: { key: s.completeRecord.key, etag: s.completeRecord.etag } });
      }
      const r = await state.transport.sessionParts(s.handle, s.size);
      s.offset = r.offset;
      s.synced = true;
      if (r.complete) await storeComplete(req.params.id, r.file, s.size);
      res.json({ ...r, partSize: DIRECT_PART_BYTES });
    } catch (err) {
      sendErr(res, err);
    }
  });

  // POST /u/api/sign-parts { id, partNumbers: [1..10000, ...] }
  // -> { urls: { "<partNumber>": "<presigned PUT url>" }, expiresIn }
  // The browser PUTs part bytes straight to B2 with these URLs; no file
  // data transits this server on the direct path.
  app.post("/u/api/sign-parts", limit(4000, 10 * 60e3), async (req, res) => {
    try {
      const company = companyOf(req);
      if (!company) return res.status(403).json({ error: "bad token" });
      const body = await readJsonBody(req);
      const s = await storeGet(body.id);
      if (!s || s.completeRecord) return res.status(404).json({ error: "unknown session" });
      if (!ownedBy(s, company)) return notOwned(res);
      const nums = [...new Set((Array.isArray(body.partNumbers) ? body.partNumbers : []).map((n) => parseInt(n, 10)))];
      if (!nums.length || nums.length > 100 || nums.some((n) => !Number.isInteger(n) || n < 1 || n > 10000)) {
        return res.status(400).json({ error: "partNumbers must be 1..100 integers in 1..10000" });
      }
      const urls = {};
      for (const n of nums) urls[n] = state.transport.presignPart(s.handle, n);
      res.json({ urls, expiresIn: PRESIGN_EXPIRES_SECONDS });
    } catch (err) {
      sendErr(res, err);
    }
  });

  // POST /u/api/complete { id } -> { complete: true, offset, file }
  // Completes the multipart session from B2's own part list (the server
  // never trusts browser-reported etags).
  app.post("/u/api/complete", limit(2000, 10 * 60e3), async (req, res) => {
    try {
      const company = companyOf(req);
      if (!company) return res.status(403).json({ error: "bad token" });
      const body = await readJsonBody(req);
      const s = await storeGet(body.id);
      if (!s) return res.status(404).json({ error: "unknown session" });
      if (!ownedBy(s, company)) return notOwned(res);
      if (s.completeRecord) return res.json({ complete: true, offset: s.completeRecord.size, file: { key: s.completeRecord.key, etag: s.completeRecord.etag } });
      // completeDirect validates the backend's own part list against the
      // declared size (contiguity, part sizes, an ETag on every part,
      // exact byte total) before completing; afterwards the finished
      // object is HEAD-verified and its ETag is required — a completion
      // without one is not reported as success.
      const file = await state.transport.completeDirect(s.handle, s.size);
      if (!file.etag) { const e = new Error("storage backend returned no ETag for the completed file"); e.httpStatus = 502; throw e; }
      const head = await state.transport.headObject(file.key);
      if (head.size !== s.size) { const e = new Error(`completed object is ${head.size} bytes, expected ${s.size}`); e.httpStatus = 502; throw e; }
      await storeComplete(body.id, file, s.size);
      res.json({ complete: true, offset: s.size, file });
    } catch (err) {
      sendErr(res, err);
    }
  });

  // POST /u/api/abort { id } — best-effort cleanup of a session the
  // sender gave up on (the bucket lifecycle rule is the backstop).
  app.post("/u/api/abort", limit(2000, 10 * 60e3), async (req, res) => {
    try {
      const company = companyOf(req);
      if (!company) return res.status(403).json({ error: "bad token" });
      const body = await readJsonBody(req);
      const s = await storeGet(body.id);
      if (s && !s.completeRecord && ownedBy(s, company)) {
        await storeDelete(body.id);
        await state.transport.abort(s.handle);
      }
      res.json({ ok: true });
    } catch (err) {
      sendErr(res, err);
    }
  });

  // PUT /u/api/chunk/:id with header x-chunk-start: <byte offset>
  app.put("/u/api/chunk/:id", async (req, res) => {
    try {
      const company = companyOf(req);
      if (!company) return res.status(403).json({ error: "bad token" });
      const s = await storeGet(req.params.id);
      if (!s || s.completeRecord) return res.status(404).json({ error: "unknown session" });
      if (!ownedBy(s, company)) return notOwned(res);
      const sync = await syncRestored(s); // restored session: re-derive parts/offset from the backend first
      if (sync && sync.complete) return res.json({ complete: true, offset: s.size, file: sync.file });
      const start = Number(req.headers["x-chunk-start"] || "0");
      if (!Number.isInteger(start) || start < 0) return res.status(400).json({ error: "x-chunk-start must be a non-negative integer byte offset" });
      const chunk = await readRaw(req);
      if (chunk.length === 0) return res.status(400).json({ error: "empty chunk" });
      if (start + chunk.length > s.size) return res.status(400).json({ error: "chunk exceeds the declared file size" });
      const isFinal = start + chunk.length >= s.size;
      if (!isFinal && chunk.length % CHUNK_GRANULARITY !== 0) {
        return res.status(400).json({ error: `non-final chunks must be multiples of ${CHUNK_GRANULARITY}` });
      }
      if (!isFinal && chunk.length < MIN_PART_BYTES) {
        return res.status(400).json({ error: `non-final chunks must be at least ${MIN_PART_BYTES} bytes (B2 multipart minimum part size)` });
      }
      const r = await state.transport.sendChunk(s.handle, chunk, start, s.size);
      s.offset = r.offset;
      if (r.complete) await storeComplete(req.params.id, r.file, s.size);
      res.json(r);
    } catch (err) {
      sendErr(res, err);
    }
  });

  if (state.enabled) {
    console.log(`crew-upload mounted at /u/<token> (transport=${state.mode}, bucket=${state.bucket}, streams=${[...state.companies.values()].map((c) => (c.subfolder ? `${c.slug}/${c.subfolder}` : c.slug)).join(", ")})`);
  }
  return { enabled: state.enabled };
};
