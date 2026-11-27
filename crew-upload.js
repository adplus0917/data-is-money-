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
  let endpointOrigin = null;
  try { endpointOrigin = new URL(env.B2_S3_ENDPOINT).origin; } catch {}
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

module.exports = function mount(app, { limiter } = {}) {
  const state = buildState(process.env);
  const limit = typeof limiter === "function" ? limiter : ((req, res, next) => next());
  const pageTemplate = fs.readFileSync(path.join(__dirname, "crew-upload.html"), "utf8");
  const sessions = new Map(); // id -> { handle, key, size, offset, createdAt }
  let sessionCounter = 0;

  const companyOf = (req) => (state.enabled ? state.companies.get(req.headers["x-upload-token"] || "") : null);

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
  app.post("/u/api/init", limit(60, 10 * 60e3), async (req, res) => {
    try {
      const company = companyOf(req);
      if (!company) return res.status(403).json({ error: "bad token" });
      const body = await readJsonBody(req);
      const name = sanitizeName(body.name);
      const size = Number(body.size);
      if (!Number.isFinite(size) || size <= 0) return res.status(400).json({ error: "invalid size" });
      if (size > MAX_FILE_BYTES) return res.status(413).json({ error: `file too large (max ${MAX_FILE_BYTES} bytes)` });
      const ext = path.extname(name).toLowerCase();
      if (BLOCKED_EXT.has(ext)) return res.status(415).json({ error: "file type not allowed" });
      if (sessions.size >= MAX_FILES * 4) return res.status(429).json({ error: "too many active sessions" });
      const uploader = sanitizeName(body.uploader || "crew");
      const key = company.subfolder
        ? `${company.slug}/${company.subfolder}/${uploader} - ${name}`
        : `${company.slug}/${uploader} - ${name}`;
      const handle = await state.transport.initSession({ key, size, mimeType: body.mimeType });
      const id = `s${++sessionCounter}-${Date.now().toString(36)}`;
      sessions.set(id, { handle, key, size, offset: 0, createdAt: Date.now() });
      res.json({ id, offset: 0, chunkGranularity: CHUNK_GRANULARITY, partSize: DIRECT_PART_BYTES, direct: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // GET /u/api/status/:id -> { offset, complete, partNumbers, partSize, file? }
  // (resume point; partNumbers lets the direct path skip parts already on B2)
  app.get("/u/api/status/:id", async (req, res) => {
    try {
      const company = companyOf(req);
      if (!company) return res.status(403).json({ error: "bad token" });
      const s = sessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: "unknown session" });
      const r = await state.transport.sessionParts(s.handle, s.size);
      s.offset = r.offset;
      if (r.complete) sessions.delete(req.params.id);
      res.json({ ...r, partSize: DIRECT_PART_BYTES });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // POST /u/api/sign-parts { id, partNumbers: [1..10000, ...] }
  // -> { urls: { "<partNumber>": "<presigned PUT url>" }, expiresIn }
  // The browser PUTs part bytes straight to B2 with these URLs; no file
  // data transits this server on the direct path.
  app.post("/u/api/sign-parts", limit(600, 10 * 60e3), async (req, res) => {
    try {
      const company = companyOf(req);
      if (!company) return res.status(403).json({ error: "bad token" });
      const body = await readJsonBody(req);
      const s = sessions.get(body.id);
      if (!s) return res.status(404).json({ error: "unknown session" });
      const nums = [...new Set((Array.isArray(body.partNumbers) ? body.partNumbers : []).map((n) => parseInt(n, 10)))];
      if (!nums.length || nums.length > 256 || nums.some((n) => !Number.isInteger(n) || n < 1 || n > 10000)) {
        return res.status(400).json({ error: "partNumbers must be 1..256 integers in 1..10000" });
      }
      const urls = {};
      for (const n of nums) urls[n] = state.transport.presignPart(s.handle, n);
      res.json({ urls, expiresIn: PRESIGN_EXPIRES_SECONDS });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // POST /u/api/complete { id } -> { complete: true, offset, file }
  // Completes the multipart session from B2's own part list (the server
  // never trusts browser-reported etags).
  app.post("/u/api/complete", limit(120, 10 * 60e3), async (req, res) => {
    try {
      const company = companyOf(req);
      if (!company) return res.status(403).json({ error: "bad token" });
      const body = await readJsonBody(req);
      const s = sessions.get(body.id);
      if (!s) return res.status(404).json({ error: "unknown session" });
      const file = await state.transport.completeDirect(s.handle);
      sessions.delete(body.id);
      res.json({ complete: true, offset: s.size, file });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // POST /u/api/abort { id } — best-effort cleanup of a session the
  // sender gave up on (the bucket lifecycle rule is the backstop).
  app.post("/u/api/abort", limit(120, 10 * 60e3), async (req, res) => {
    try {
      const company = companyOf(req);
      if (!company) return res.status(403).json({ error: "bad token" });
      const body = await readJsonBody(req);
      const s = sessions.get(body.id);
      if (s) {
        sessions.delete(body.id);
        await state.transport.abort(s.handle);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // PUT /u/api/chunk/:id with header x-chunk-start: <byte offset>
  app.put("/u/api/chunk/:id", async (req, res) => {
    try {
      const company = companyOf(req);
      if (!company) return res.status(403).json({ error: "bad token" });
      const s = sessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: "unknown session" });
      const start = parseInt(req.headers["x-chunk-start"] || "0", 10);
      const chunk = await readRaw(req);
      if (chunk.length === 0) return res.status(400).json({ error: "empty chunk" });
      const isFinal = start + chunk.length >= s.size;
      if (!isFinal && chunk.length % CHUNK_GRANULARITY !== 0) {
        return res.status(400).json({ error: `non-final chunks must be multiples of ${CHUNK_GRANULARITY}` });
      }
      if (!isFinal && chunk.length < MIN_PART_BYTES) {
        return res.status(400).json({ error: `non-final chunks must be at least ${MIN_PART_BYTES} bytes (B2 multipart minimum part size)` });
      }
      const r = await state.transport.sendChunk(s.handle, chunk, start, s.size);
      s.offset = r.offset;
      if (r.complete) sessions.delete(req.params.id);
      res.json(r);
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  if (state.enabled) {
    console.log(`crew-upload mounted at /u/<token> (transport=${state.mode}, bucket=${state.bucket}, streams=${[...state.companies.values()].map((c) => (c.subfolder ? `${c.slug}/${c.subfolder}` : c.slug)).join(", ")})`);
  }
  return { enabled: state.enabled };
};
