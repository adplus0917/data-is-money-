// ============================================================
// Worker (NON-admin) data-room accounts + per-customer folders
// (Nov 27 2026, Miguel's order).
//
// Miguel's model: every customer gets the same fixed folder set —
// intake / incoming / verified master / working copy / buyer view /
// contracts / correspondence / offers — created automatically when
// the customer (submission) is created. Regular team workers and
// laborers who receive folders get their OWN account type and their
// OWN page (/work), separate from the admin panel:
//
//   * a worker sees ONLY the customers an admin assigned to them;
//   * a worker can open files in the working folders (intake,
//     incoming, working copy, contracts, correspondence, offers);
//   * a worker can NEVER open master files — "verified master" shows
//     names/sizes/hashes only, and every open attempt (granted or
//     refused) is written to worker_access_log AND the hash-chained
//     audit log under the worker's name;
//   * buyer view is produced only by the viewing builder for invited
//     buyers — workers do not open it either;
//   * worker sessions (dp_worker cookie) are a different credential
//     from staff (dp_staff) and admin (dp_admin) sessions: a worker
//     cookie satisfies NO admin route, and admin routes for managing
//     workers require a staff session with the admin role.
//
// Folder files are working copies an admin places with the console
// endpoint below (stored in the staging bucket under worker-folders/);
// masters arrive only through the vault ingest pipeline
// (upload_files), exactly as before — this module never writes to the
// master bucket and the web service still holds no master keys.
// ============================================================
const crypto = require("crypto");
const multer = require("multer");
const staff = require("./staff");
const storage = require("./storage");
const s3 = require("../vault/lib/s3");

const FOLDERS = ["intake", "incoming", "verified master", "working copy", "buyer view", "contracts", "correspondence", "offers"];
const OPENABLE = new Set(["intake", "incoming", "working copy", "contracts", "correspondence", "offers"]);
const COOKIE = "dp_worker";
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const HOURS = 12;
const PROD = process.env.NODE_ENV === "production";
const sign = (v) => crypto.createHmac("sha256", SECRET).update(v).digest("hex");

function issueWorker(res, user) {
  const payload = Buffer.from(JSON.stringify({
    wid: user.id, username: user.username, name: user.name,
    exp: Date.now() + HOURS * 3600e3,
  })).toString("base64url");
  res.setHeader("Set-Cookie", `${COOKIE}=${payload}.${sign(payload)}; HttpOnly; Path=/; Max-Age=${HOURS * 3600}; SameSite=Strict${PROD ? "; Secure" : ""}`);
}
function clearWorker(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict${PROD ? "; Secure" : ""}`);
}
// Returns {id, username, name} for a valid worker cookie, else null.
// Worker cookies are signed exactly like staff cookies but under a
// different name and payload shape, so they can never be replayed as
// a staff/admin session (staffOf also rejects roles it doesn't know).
function workerOf(req) {
  try {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || "");
    if (!m) return null;
    const [payload, sig] = m[1].split(".");
    if (!payload || !sig || !/^[0-9a-f]{64}$/.test(sig)) return null;
    const given = Buffer.from(sig, "hex"), expected = Buffer.from(sign(payload), "hex");
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.wid || !data.username || Number(data.exp) <= Date.now()) return null;
    return { id: data.wid, username: data.username, name: data.name };
  } catch { return null; }
}

const sanitizeName = (name) => String(name || "file").replace(/[\\/]/g, "_").replace(/[\x00-\x1f]/g, "").trim().slice(0, 160) || "file";

module.exports = function mount(app, { db, limiter, log } = {}) {
  const pool = db && db.pool;
  const limit = typeof limiter === "function" ? limiter : ((req, res, next) => next());
  const auditLog = typeof log === "function" ? log : (() => Promise.resolve());
  if (!pool) {
    console.log("worker-routes: disabled (no Postgres pool)");
    return { ensureFolders: async () => {} };
  }

  async function ensureFolders(folio) {
    if (!folio) return;
    for (const folder of FOLDERS) {
      await pool.query(`INSERT INTO customer_folders (folio, folder) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [folio, folder]);
    }
  }

  async function accessLog(req, w, entry) {
    try {
      await pool.query(
        `INSERT INTO worker_access_log (worker_id, username, folio, folder, file_id, file_name, action, ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [w ? w.id : null, w ? w.username : null, entry.folio || null, entry.folder || null,
         entry.file_id || null, entry.file_name || null, entry.action, req.ip || null]);
    } catch (e) { console.error("worker access log failed", e.message); }
    auditLog({
      actor: w ? `worker:${w.username}` : "worker:unknown",
      action: `worker.${entry.action}`,
      folio: entry.folio || undefined,
      detail: { folder: entry.folder, file_id: entry.file_id, file_name: entry.file_name, ip: req.ip },
    }).catch(() => {});
  }

  function guard(req, res, next) {
    const w = workerOf(req);
    if (!w) return res.status(401).json({ error: "worker sign in required" });
    req.worker = w;
    next();
  }
  async function isAssigned(workerId, folio) {
    const { rows } = await pool.query(`SELECT 1 FROM worker_assignments WHERE worker_id = $1 AND folio = $2`, [workerId, folio]);
    return rows.length > 0;
  }

  /* ---------------- worker auth ---------------- */
  app.post("/api/worker/login", limit(8, 60e3), async (req, res) => {
    try {
      const username = String((req.body || {}).username || "").trim().toLowerCase();
      const password = String((req.body || {}).password || "");
      const { rows } = await pool.query(`SELECT * FROM worker_users WHERE username = $1`, [username]);
      const u = rows[0];
      if (!u || !u.active || !staff.verifyPassword(password, u.password_hash)) {
        auditLog({ actor: `worker-login@${req.ip}`, action: "worker.login_failed", detail: { username } }).catch(() => {});
        return res.status(401).json({ error: "wrong username or password" });
      }
      await pool.query(`UPDATE worker_users SET last_login_at = now() WHERE id = $1`, [u.id]);
      issueWorker(res, u);
      await accessLog(req, { id: u.id, username: u.username }, { action: "login" });
      res.json({ ok: true, username: u.username, name: u.name });
    } catch (e) { console.error("worker login", e); res.status(500).json({ error: "sign in failed" }); }
  });
  app.post("/api/worker/logout", (req, res) => { clearWorker(res); res.json({ ok: true }); });
  app.get("/api/worker/me", guard, (req, res) => res.json({ username: req.worker.username, name: req.worker.name }));

  /* ---------------- worker data ---------------- */
  app.get("/api/worker/customers", guard, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT s.folio, s.company_name
           FROM worker_assignments a JOIN submissions s ON s.folio = a.folio
          WHERE a.worker_id = $1 ORDER BY s.company_name`, [req.worker.id]);
      const out = [];
      for (const c of rows) {
        await ensureFolders(c.folio);
        const { rows: counts } = await pool.query(
          `SELECT folder, count(*)::int AS n FROM folder_files WHERE folio = $1 GROUP BY folder`, [c.folio]);
        const byFolder = Object.fromEntries(counts.map((r) => [r.folder, r.n]));
        const { rows: [m] } = await pool.query(
          `SELECT count(*)::int AS n FROM upload_files WHERE folio = $1 AND status = 'ingested'`, [c.folio]);
        out.push({
          folio: c.folio, company_name: c.company_name,
          folders: FOLDERS.map((folder) => ({
            folder,
            locked: !OPENABLE.has(folder),
            files: folder === "verified master" ? (m ? m.n : 0) : (byFolder[folder] || 0),
          })),
        });
      }
      res.json({ customers: out });
    } catch (e) { console.error("worker customers", e); res.status(500).json({ error: "could not load customers" }); }
  });

  app.get("/api/worker/customers/:folio", guard, async (req, res) => {
    try {
      const folio = req.params.folio;
      if (!(await isAssigned(req.worker.id, folio))) return res.status(403).json({ error: "this customer is not assigned to you" });
      await ensureFolders(folio);
      const { rows: placed } = await pool.query(
        `SELECT id, folder, name, size, created_at FROM folder_files WHERE folio = $1 ORDER BY folder, created_at`, [folio]);
      const { rows: masters } = await pool.query(
        `SELECT id, original_name AS name, size_bytes AS size, sha256_master FROM upload_files WHERE folio = $1 AND status = 'ingested' ORDER BY id`, [folio]);
      const folders = FOLDERS.map((folder) => ({
        folder,
        locked: !OPENABLE.has(folder),
        files: [
          ...placed.filter((f) => f.folder === folder).map((f) => ({ id: f.id, source: "folder", name: f.name, size: Number(f.size), created_at: f.created_at })),
          ...(folder === "verified master"
            ? masters.map((f) => ({ id: f.id, source: "vault", name: f.name, size: Number(f.size), sha256: f.sha256_master, locked: true }))
            : []),
        ],
      }));
      res.json({ folio, folders });
    } catch (e) { console.error("worker customer detail", e); res.status(500).json({ error: "could not load the customer" }); }
  });

  // Open a file. Every attempt — granted or refused — is logged under
  // the worker's name. Masters are refused here at the API, not just
  // hidden in the page: there is no worker path to master bytes.
  app.post("/api/worker/customers/:folio/open", guard, limit(120, 60e3), async (req, res) => {
    const folio = req.params.folio;
    const { folder, source, file_id } = req.body || {};
    try {
      if (!(await isAssigned(req.worker.id, folio))) {
        await accessLog(req, req.worker, { action: "open_refused_unassigned", folio, folder, file_id });
        return res.status(403).json({ error: "this customer is not assigned to you" });
      }
      if (!FOLDERS.includes(folder)) return res.status(400).json({ error: "unknown folder" });
      if (!OPENABLE.has(folder) || source === "vault") {
        const { rows } = source === "vault"
          ? await pool.query(`SELECT original_name AS name FROM upload_files WHERE id = $1 AND folio = $2`, [file_id, folio])
          : await pool.query(`SELECT name FROM folder_files WHERE id = $1 AND folio = $2`, [file_id, folio]);
        await accessLog(req, req.worker, {
          action: "open_refused_master", folio, folder, file_id,
          file_name: rows[0] ? rows[0].name : null,
        });
        return res.status(403).json({ error: "master files cannot be opened by worker accounts — ask an admin if you need something from this file" });
      }
      const { rows } = await pool.query(
        `SELECT * FROM folder_files WHERE id = $1 AND folio = $2 AND folder = $3`, [file_id, folio, folder]);
      const f = rows[0];
      if (!f) return res.status(404).json({ error: "file not found in this folder" });
      const staging = s3.role("staging");
      if (!staging) return res.status(503).json({ error: "file storage is not configured" });
      const url = await staging.presignGet(f.storage_key, 300);
      await accessLog(req, req.worker, { action: "file_open", folio, folder, file_id: f.id, file_name: f.name });
      res.json({ url, name: f.name });
    } catch (e) { console.error("worker open", e); res.status(500).json({ error: "could not open the file" }); }
  });

  /* ---------------- admin side (staff session, admin role) ---------------- */
  const adminOnly = [staff.guard, staff.requireAdminRole];

  app.get("/api/admin/console/workers", ...adminOnly, async (req, res) => {
    try {
      const { rows: workers } = await pool.query(
        `SELECT id, username, name, active, created_by, created_at, last_login_at FROM worker_users ORDER BY username`);
      const { rows: assignments } = await pool.query(
        `SELECT worker_id, folio, assigned_by, created_at FROM worker_assignments ORDER BY folio`);
      res.json({ workers, assignments, folders: FOLDERS });
    } catch (e) { console.error("console workers list", e); res.status(500).json({ error: "could not list workers" }); }
  });

  app.post("/api/admin/console/workers", ...adminOnly, limit(20, 60e3), async (req, res) => {
    try {
      const username = String((req.body || {}).username || "").trim().toLowerCase();
      const name = String((req.body || {}).name || "").trim();
      const password = String((req.body || {}).password || "");
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) return res.status(400).json({ error: "username must be 3-32 characters: letters, numbers, dot, dash, underscore" });
      if (!name) return res.status(400).json({ error: "name is required" });
      if (password.length < 10) return res.status(400).json({ error: "password must be at least 10 characters" });
      const { rows } = await pool.query(
        `INSERT INTO worker_users (username, name, password_hash, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (username) DO NOTHING RETURNING id, username, name, active, created_at`,
        [username, name, staff.hashPassword(password), staff.actorOf(req)]);
      if (!rows[0]) return res.status(409).json({ error: "that username already exists" });
      auditLog({ actor: staff.actorOf(req), action: "worker.created", detail: { username, name } }).catch(() => {});
      res.status(201).json({ worker: rows[0] });
    } catch (e) { console.error("console worker create", e); res.status(500).json({ error: "could not create the worker" }); }
  });

  app.post("/api/admin/console/workers/:id/active", ...adminOnly, async (req, res) => {
    try {
      const active = !!(req.body || {}).active;
      const { rows } = await pool.query(`UPDATE worker_users SET active = $1 WHERE id = $2 RETURNING id, username, active`, [active, req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: "worker not found" });
      auditLog({ actor: staff.actorOf(req), action: active ? "worker.activated" : "worker.deactivated", detail: { worker_id: req.params.id } }).catch(() => {});
      res.json({ worker: rows[0] });
    } catch (e) { console.error("console worker active", e); res.status(500).json({ error: "could not update the worker" }); }
  });

  app.post("/api/admin/console/workers/:id/password", ...adminOnly, async (req, res) => {
    try {
      const password = String((req.body || {}).password || "");
      if (password.length < 10) return res.status(400).json({ error: "password must be at least 10 characters" });
      const { rows } = await pool.query(`UPDATE worker_users SET password_hash = $1 WHERE id = $2 RETURNING id, username`, [staff.hashPassword(password), req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: "worker not found" });
      auditLog({ actor: staff.actorOf(req), action: "worker.password_reset", detail: { worker_id: req.params.id } }).catch(() => {});
      res.json({ ok: true });
    } catch (e) { console.error("console worker password", e); res.status(500).json({ error: "could not reset the password" }); }
  });

  app.post("/api/admin/console/workers/:id/assign", ...adminOnly, async (req, res) => {
    try {
      const folio = String((req.body || {}).folio || "").trim();
      const { rows: sub } = await pool.query(`SELECT folio, company_name FROM submissions WHERE folio = $1`, [folio]);
      if (!sub[0]) return res.status(404).json({ error: "no customer (submission) with that folio" });
      const { rows: w } = await pool.query(`SELECT id FROM worker_users WHERE id = $1`, [req.params.id]);
      if (!w[0]) return res.status(404).json({ error: "worker not found" });
      await ensureFolders(folio);
      await pool.query(
        `INSERT INTO worker_assignments (worker_id, folio, assigned_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [req.params.id, folio, staff.actorOf(req)]);
      auditLog({ actor: staff.actorOf(req), action: "worker.assigned", folio, detail: { worker_id: req.params.id } }).catch(() => {});
      res.json({ ok: true, folio, company_name: sub[0].company_name });
    } catch (e) { console.error("console worker assign", e); res.status(500).json({ error: "could not assign the customer" }); }
  });

  app.post("/api/admin/console/workers/:id/unassign", ...adminOnly, async (req, res) => {
    try {
      const folio = String((req.body || {}).folio || "").trim();
      await pool.query(`DELETE FROM worker_assignments WHERE worker_id = $1 AND folio = $2`, [req.params.id, folio]);
      auditLog({ actor: staff.actorOf(req), action: "worker.unassigned", folio, detail: { worker_id: req.params.id } }).catch(() => {});
      res.json({ ok: true });
    } catch (e) { console.error("console worker unassign", e); res.status(500).json({ error: "could not unassign the customer" }); }
  });

  app.get("/api/admin/console/workers/access", ...adminOnly, async (req, res) => {
    try {
      const workerId = Number((req.query || {}).worker_id) || null;
      const { rows } = workerId
        ? await pool.query(`SELECT * FROM worker_access_log WHERE worker_id = $1 ORDER BY id DESC LIMIT 100`, [workerId])
        : await pool.query(`SELECT * FROM worker_access_log ORDER BY id DESC LIMIT 100`);
      res.json({ access: rows });
    } catch (e) { console.error("console worker access", e); res.status(500).json({ error: "could not load the access log" }); }
  });

  // Place a working file into a customer's folder. Masters and buyer
  // view are refused here on purpose: masters arrive only through the
  // vault ingest pipeline and buyer view only from the builder.
  const placeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: storage.MAX_MB * 1048576, files: 1 } });
  app.post("/api/admin/console/folders/file", ...adminOnly, placeUpload.single("file"), async (req, res) => {
    try {
      const folio = String((req.body || {}).folio || "").trim();
      const folder = String((req.body || {}).folder || "").trim();
      if (!FOLDERS.includes(folder)) return res.status(400).json({ error: "unknown folder" });
      if (!OPENABLE.has(folder)) return res.status(400).json({ error: `"${folder}" cannot be filled here — masters come from the vault pipeline and buyer view from the viewing builder` });
      const { rows: sub } = await pool.query(`SELECT folio FROM submissions WHERE folio = $1`, [folio]);
      if (!sub[0]) return res.status(404).json({ error: "no customer (submission) with that folio" });
      if (!req.file) return res.status(400).json({ error: "file is required" });
      const staging = s3.role("staging");
      if (!staging) return res.status(503).json({ error: "file storage is not configured" });
      await ensureFolders(folio);
      const name = sanitizeName(req.file.originalname);
      const key = `worker-folders/${folio}/${encodeURIComponent(folder)}/${crypto.randomUUID()}-${name}`;
      await staging.put(key, req.file.buffer, { contentType: req.file.mimetype || "application/octet-stream" });
      const { rows } = await pool.query(
        `INSERT INTO folder_files (folio, folder, name, storage, storage_key, size, mime, uploaded_by)
         VALUES ($1, $2, $3, 'staging', $4, $5, $6, $7) RETURNING id, name, size, created_at`,
        [folio, folder, name, key, req.file.size, req.file.mimetype || null, staff.actorOf(req)]);
      auditLog({ actor: staff.actorOf(req), action: "folder.file_placed", folio, detail: { folder, name, size: req.file.size } }).catch(() => {});
      res.status(201).json({ file: rows[0] });
    } catch (e) { console.error("console folder file", e); res.status(500).json({ error: "could not place the file" }); }
  });

  console.log("worker-routes mounted at /work (worker accounts + customer folders)");
  return { ensureFolders };
};
