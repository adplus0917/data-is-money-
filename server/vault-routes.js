// ============================================================
// Vault routes on the WEBSITE server (runs in the cloud).
// The website holds ONE storage key: staging, PUT only.
// It cannot read staging back, and has no master / viewing / quarantine keys.
// Everything else it does here is database work: recording files,
// the verification gate, engagements, invites, sessions, audit queries.
// Active when DATABASE_URL (PostgreSQL) and STAGING_BUCKET are set.
// ============================================================
const crypto = require("crypto");
const path = require("path");
const express = require("express");
const multer = require("multer");
const s3 = require("../vault/lib/s3");
const { scanBuffer } = require("../vault/lib/scan");
const { audit, query: auditQuery, verifyChain, alert, sha } = require("../vault/lib/audit");
const jobs = require("../vault/lib/jobs");
const storage = require("./storage");
const opt = require("./options");

const MAX_SAMPLE_MB = Number(process.env.MAX_UPLOAD_MB || 20);
const MAX_DIRECT_GB = Number(process.env.MAX_DIRECT_UPLOAD_GB || 5);   // single presigned PUT limit on S3-compatible storage
const ALLOWED = storage.ALLOWED;
const extOf = n => path.extname(String(n || "")).toLowerCase().replace(/^\./, "");

module.exports = function mount(app, { db, auth, limiter }) {
  const pool = db.pool;
  const staging = s3.role("staging");
  const enabled = !!(pool && staging);
  if (!enabled) return { enabled: false };
  if (s3.role("master") || s3.role("viewing") || s3.role("quarantine"))
    throw new Error("The website must hold STAGING keys only. Remove MASTER_/VIEWING_/QUARANTINE_ variables from the web service.");

  const actorAdmin = req => `admin@${req.ip}`;

  /* ---------- seller: check the private upload token ---------- */
  async function tokenOk(req, res) {
    const folio = String(req.params.folio);
    const hash = await db.getUploadTokenHash(folio);
    const given = sha(String(req.get("X-Upload-Token") || ""));
    if (!hash || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(given))) { res.status(403).json({ error: "upload link not valid" }); return null; }
    return folio;
  }

  /* small files (≤ MAX_UPLOAD_MB): through this server, scanned + hashed here, then to staging */
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_SAMPLE_MB * 1048576, files: 10 } });
  app.post("/api/submissions/:folio/samples", limiter(40, 10 * 60e3), (req, res, next) => {
    upload.array("files", 10)(req, res, err => err ? res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? `file too large for this box (max ${MAX_SAMPLE_MB} MB); large files upload directly` : "upload failed" }) : next());
  }, async (req, res) => {
    const folio = await tokenOk(req, res); if (!folio) return;
    const saved = [], rejected = [];
    for (const f of req.files || []) {
      const ext = extOf(f.originalname);
      if (!ALLOWED.includes("." + ext)) { rejected.push({ name: f.originalname, reason: "file type not accepted" }); continue; }
      const scan = await scanBuffer(f.buffer, ext);
      if (scan.scan_status === "infected" || scan.scan_status === "format_mismatch") {
        rejected.push({ name: f.originalname, reason: scan.scan_status === "infected" ? "virus detected" : `content does not match .${ext}` });
        await audit(pool, { actor: "seller:" + folio, action: "upload.rejected", folio, detail: { name: f.originalname, reason: scan.scan_status, detail: scan.scan_detail, sha256: scan.sha256 } });
        if (scan.scan_status === "infected") await alert(`🛑 ${folio}: archivo con virus rechazado en la carga ("${f.originalname}").`);
        continue;                                   // never stored
      }
      const id = crypto.randomUUID(), key = `${folio}/${id}`;
      await staging.put(key, f.buffer, { contentType: "application/octet-stream", metadata: { folio, file: id, sha256: scan.sha256 } });
      await pool.query(`INSERT INTO upload_files (id, folio, kind, original_name, ext, size_bytes, staging_key, sha256_upload, scan_status, scan_detail, status, staged_at)
                        VALUES ($1,$2,'sample',$3,$4,$5,$6,$7,'pending',$8,'in_staging',now())`,
        [id, folio, opt.str(f.originalname, 200), ext, f.size, key, scan.sha256, `web: ${scan.scan_status}`]);
      await audit(pool, { actor: "seller:" + folio, action: "upload.staged", folio, detail: { file: id, name: f.originalname, size: f.size, sha256: scan.sha256, via: "web" } });
      saved.push({ id, name: f.originalname, size: f.size, sha256: scan.sha256 });
    }
    if (!saved.length && rejected.length) return res.status(400).json({ error: rejected.map(r => `${r.name}: ${r.reason}`).join("; "), rejected });
    res.status(201).json({ saved, rejected });
  });

  /* large files: browser uploads straight to the encrypted staging bucket with a 1-hour signed URL.
     Hash + virus scan happen in the ingest worker BEFORE anything reaches master. */
  app.post("/api/submissions/:folio/uploads", limiter(60, 10 * 60e3), async (req, res) => {
    const folio = await tokenOk(req, res); if (!folio) return;
    const files = Array.isArray(req.body && req.body.files) ? req.body.files.slice(0, 50) : [];
    const kind = req.body.kind === "corpus" ? "corpus" : "sample";
    const out = [];
    for (const f of files) {
      const ext = extOf(f.name), size = Number(f.size) || 0;
      if (!ALLOWED.includes("." + ext)) { out.push({ name: f.name, error: "file type not accepted" }); continue; }
      if (size <= 0 || size > MAX_DIRECT_GB * 1073741824) { out.push({ name: f.name, error: `max ${MAX_DIRECT_GB} GB per file` }); continue; }
      const id = crypto.randomUUID(), key = `${folio}/${id}`;
      await pool.query(`INSERT INTO upload_files (id, folio, kind, original_name, ext, size_bytes, staging_key) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, folio, kind, opt.str(f.name, 200), ext, size, key]);
      out.push({ id, name: f.name, url: await staging.presignPut(key, "application/octet-stream", 3600), headers: { "Content-Type": "application/octet-stream" } });
    }
    await audit(pool, { actor: "seller:" + folio, action: "upload.presigned", folio, detail: { files: out.filter(o => o.id).map(o => o.id), kind } });
    res.status(201).json({ files: out });
  });

  app.post("/api/submissions/:folio/uploads/:id/complete", limiter(120, 10 * 60e3), async (req, res) => {
    const folio = await tokenOk(req, res); if (!folio) return;
    const { rowCount } = await pool.query(`UPDATE upload_files SET status='in_staging', staged_at=now() WHERE id=$1 AND folio=$2 AND status='awaiting_upload'`, [req.params.id, folio]);
    if (!rowCount) return res.status(404).json({ error: "unknown upload" });
    await audit(pool, { actor: "seller:" + folio, action: "upload.staged", folio, detail: { file: req.params.id, via: "direct" } });
    res.json({ ok: true });
  });

  /* ---------- team panel ---------- */
  const A = express.Router();
  A.use(["/vault", "/submissions"], auth.requireAdmin);   // every route in this router needs the team sign-in

  // new private upload link for a seller (for the full corpus delivery)
  A.post("/submissions/:folio/upload-link", async (req, res) => {
    const token = crypto.randomBytes(24).toString("hex");
    const { rowCount } = await pool.query(`UPDATE submissions SET upload_token_hash=$2 WHERE folio=$1`, [req.params.folio, sha(token)]);
    if (!rowCount) return res.status(404).json({ error: "folio not found" });
    await audit(pool, { actor: actorAdmin(req), action: "admin.upload_link", folio: req.params.folio });
    const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
    res.json({ url: `${base}/deliver#${req.params.folio}.${token}` });
  });

  A.get("/vault/overview", async (req, res) => {
    const [corp, files, eng, sess, jobsQ] = await Promise.all([
      pool.query(`SELECT c.*, s.company_name FROM corpora c JOIN submissions s USING (folio) ORDER BY c.folio DESC`),
      pool.query(`SELECT id, folio, kind, original_name, ext, size_bytes, sha256_upload, sha256_staging, sha256_master, scan_status, scan_detail, status, profile, created_at, staged_at, ingested_at FROM upload_files ORDER BY created_at DESC LIMIT 2000`),
      pool.query(`SELECT e.id, e.kind, e.buyer_name, e.folios, e.redaction, e.expires_at, e.status, e.built_at, e.closed_at, e.last_error, e.withheld,
                    jsonb_array_length(coalesce(e.manifest,'[]')) AS files,
                    (SELECT json_agg(json_build_object('id',v.id,'name',v.name,'email',v.email,'revoked',v.revoked_at IS NOT NULL) ORDER BY v.created_at) FROM viewers v WHERE v.engagement_id=e.id) AS viewers
                  FROM engagements e ORDER BY e.created_at DESC`),
      pool.query(`SELECT s.id, s.started_at, s.last_seen, s.ended_at, s.end_reason, s.ip, s.page_views, s.warnings, v.email, e.buyer_name
                  FROM viewer_sessions s JOIN viewers v ON v.id=s.viewer_id JOIN engagements e ON e.id=s.engagement_id ORDER BY s.started_at DESC LIMIT 200`),
      pool.query(`SELECT status, count(*)::int n FROM jobs GROUP BY status`),
    ]);
    res.json({ corpora: corp.rows, files: files.rows, engagements: eng.rows, sessions: sess.rows, jobs: jobsQ.rows });
  });

  // VERIFICATION GATE: only this action unlocks a corpus for viewing copies
  A.post("/vault/corpora/:folio/:action", async (req, res) => {
    if (!["verify", "reject"].includes(req.params.action)) return res.status(404).end();
    const status = req.params.action === "verify" ? "verified" : "rejected";
    const { rowCount } = await pool.query(`UPDATE corpora SET status=$2, verified_at=now(), verified_by=$3, note=$4 WHERE folio=$1`,
      [req.params.folio, status, actorAdmin(req), opt.str(req.body && req.body.note, 500) || null]);
    if (!rowCount) return res.status(404).json({ error: "no corpus for this folio yet" });
    if (status === "verified") await pool.query(`UPDATE submissions SET status='Verificado' WHERE folio=$1 AND status IN ('Nuevo','Contactado','Papel enviado','Firmado','Muestra recibida')`, [req.params.folio]);
    await audit(pool, { actor: actorAdmin(req), action: "admin." + req.params.action, folio: req.params.folio, detail: { note: req.body && req.body.note } });
    res.json({ ok: true });
  });

  A.post("/vault/engagements", async (req, res) => {
    const b = req.body || {};
    const buyer = opt.str(b.buyer_name, 120), folios = (Array.isArray(b.folios) ? b.folios : String(b.folios || "").split(/[\s,]+/)).filter(f => /^DP-\d{4}-\d{4,}$/.test(f));
    const exp = new Date(b.expires_at);
    if (!buyer || !folios.length || isNaN(exp) || exp <= new Date()) return res.status(400).json({ error: "buyer, at least one folio and a future end date are required" });
    if (exp - Date.now() > 366 * 864e5) return res.status(400).json({ error: "end date must be within one year" });
    const kind = b.kind === "internal_review" ? "internal_review" : "buyer";
    const redaction = { mode: b.redaction_mode === "none" ? "none" : "pii", columns: String(b.columns || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 40) };
    const id = crypto.randomUUID();
    await pool.query(`INSERT INTO engagements (id, kind, buyer_name, folios, redaction, expires_at, viewing_prefix, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, kind, buyer, folios, JSON.stringify(redaction), exp, `eng-${id}/`, actorAdmin(req)]);
    await jobs.enqueue(pool, "build_engagement", { engagement_id: id });
    await audit(pool, { actor: actorAdmin(req), action: "admin.engagement_create", engagement_id: id, detail: { buyer, folios, kind, redaction, expires_at: exp } });
    await alert(`🔑 Nuevo acceso al data room: "${buyer}" → ${folios.join(", ")} hasta ${exp.toISOString().slice(0, 10)} (${actorAdmin(req)}).`);
    res.status(201).json({ id });
  });

  A.post("/vault/engagements/:id/rebuild", async (req, res) => {
    await pool.query(`UPDATE engagements SET status='requested' WHERE id=$1 AND status IN ('failed','ready')`, [req.params.id]);
    await jobs.enqueue(pool, "build_engagement", { engagement_id: req.params.id });
    await audit(pool, { actor: actorAdmin(req), action: "admin.engagement_rebuild", engagement_id: req.params.id });
    res.json({ ok: true });
  });

  A.post("/vault/engagements/:id/revoke", async (req, res) => {
    await pool.query(`UPDATE engagements SET status='revoked' WHERE id=$1 AND status NOT IN ('expired','revoked')`, [req.params.id]);
    await pool.query(`UPDATE viewer_sessions SET ended_at=now(), end_reason='engagement_revoked' WHERE engagement_id=$1 AND ended_at IS NULL`, [req.params.id]);
    await jobs.enqueue(pool, "close_engagement", { engagement_id: req.params.id, reason: "revoked" });
    await audit(pool, { actor: actorAdmin(req), action: "admin.engagement_revoke", engagement_id: req.params.id });
    res.json({ ok: true });
  });

  // invite a viewer: the link and the code are shown ONCE; send them by two different channels
  A.post("/vault/engagements/:id/viewers", async (req, res) => {
    const name = opt.str(req.body && req.body.name, 120), email = opt.str(req.body && req.body.email, 200).toLowerCase();
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "name and email required" });
    const { rows: [e] } = await pool.query(`SELECT id, status FROM engagements WHERE id=$1`, [req.params.id]);
    if (!e || ["expired", "revoked"].includes(e.status)) return res.status(400).json({ error: "engagement is closed" });
    const invite = crypto.randomBytes(24).toString("base64url");
    const code = Array.from(crypto.randomBytes(8), b => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
    const id = crypto.randomUUID();
    await pool.query(`INSERT INTO viewers (id, engagement_id, name, email, invite_hash, code_hash) VALUES ($1,$2,$3,$4,$5,$6)`, [id, e.id, name, email, sha(invite), sha(code)]);
    await audit(pool, { actor: actorAdmin(req), action: "admin.viewer_invite", engagement_id: e.id, detail: { viewer: id, email } });
    await alert(`👤 Visor invitado al data room: ${email} (${actorAdmin(req)}).`);
    const base = process.env.DATAROOM_URL || "https://room.example.com";
    res.status(201).json({ id, link: `${base}/r#${invite}`, code });
  });

  A.post("/vault/viewers/:id/revoke", async (req, res) => {
    const { rows: [v] } = await pool.query(`UPDATE viewers SET revoked_at=now() WHERE id=$1 RETURNING engagement_id`, [req.params.id]);
    await pool.query(`UPDATE viewer_sessions SET ended_at=now(), end_reason='viewer_revoked' WHERE viewer_id=$1 AND ended_at IS NULL`, [req.params.id]);
    await audit(pool, { actor: actorAdmin(req), action: "admin.viewer_revoke", engagement_id: v && v.engagement_id, detail: { viewer: req.params.id } });
    res.json({ ok: true });
  });

  A.post("/vault/sessions/:id/cut", async (req, res) => {
    const { rows: [s] } = await pool.query(`UPDATE viewer_sessions SET ended_at=now(), end_reason='cut_by_admin' WHERE id=$1 AND ended_at IS NULL RETURNING engagement_id`, [req.params.id]);
    await audit(pool, { actor: actorAdmin(req), action: "admin.session_cut", engagement_id: s && s.engagement_id, detail: { session: req.params.id } });
    res.json({ ok: true });
  });

  A.get("/vault/audit", async (req, res) => res.json(await auditQuery(pool, req.query)));
  A.get("/vault/audit/verify", async (req, res) => res.json(await verifyChain(pool)));

  app.use("/api/admin", A);

  /* ---------- watchdog (the website is always on, the rack may not be) ---------- */
  async function watchdog() {
    try {
      const { rows } = await pool.query(
        `SELECT folio, count(*)::int n, min(staged_at) oldest FROM upload_files
         WHERE status='in_staging' AND staged_at < now() - interval '4 days'
           AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.action='watchdog.staging_age' AND a.folio=upload_files.folio AND a.at > now() - interval '1 day')
         GROUP BY folio`);
      for (const r of rows) {
        await audit(pool, { actor: "web:watchdog", action: "watchdog.staging_age", folio: r.folio, detail: { files: r.n, oldest: r.oldest } });
        await alert(`⏳ ${r.folio}: ${r.n} archivo(s) llevan más de 4 días en staging. ¿El vault está en línea? Staging borra a los 7 días.`);
      }
      const { rows: [f] } = await pool.query(`SELECT count(*)::int n FROM jobs WHERE status='failed' AND created_at > now() - interval '1 day'`);
      if (f.n) await alert(`⚠️ ${f.n} trabajo(s) del vault fallaron en las últimas 24 h. Revisar el panel.`);
    } catch (e) { console.error("watchdog", e.message); }
  }
  setInterval(watchdog, 6 * 3600e3).unref();
  setTimeout(watchdog, 60e3).unref();

  console.log("vault: ON (uploads go to the staging bucket)");
  return { enabled: true };
};
