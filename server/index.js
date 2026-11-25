// ============================================================
// DATA Patrimonio — web server
// Serves the seller site (public/), the team panel (public/admin.html)
// and the API the pages call. Start with:  npm start
// ============================================================
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const express = require("express");
const multer = require("multer");

const db = require("./db");
const storage = require("./storage");
const auth = require("./auth");
const { valueDataset, ENGINE_VERSION } = require("./engine");
const opt = require("./options");
const { answerChat } = require("./chat");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, "..", "public");

app.set("trust proxy", 1);           // correct client IPs behind Render/Railway's proxy
app.disable("x-powered-by");

/* ---------- security headers on every response ---------- */
const STAGING_ORIGIN = (() => {
  if (process.env.STAGING_PUBLIC_ORIGIN) return process.env.STAGING_PUBLIC_ORIGIN;
  try { return process.env.STAGING_S3_ENDPOINT ? new URL(process.env.STAGING_S3_ENDPOINT).origin : (process.env.STAGING_BUCKET ? "https://*.amazonaws.com" : ""); } catch (e) { return ""; }
})();
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'" + (STAGING_ORIGIN ? " " + STAGING_ORIGIN : ""),   // large uploads go straight to the staging bucket
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

/* ---------- simple per-IP rate limits (in memory) ---------- */
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now(), k = req.ip;
    const h = hits.get(k) || { n: 0, reset: now + windowMs };
    if (h.reset < now) { h.n = 0; h.reset = now + windowMs; }
    h.n++; hits.set(k, h);
    if (h.n > max) return res.status(429).json({ error: "too many requests, try again later" });
    next();
  };
}

app.use("/api/submissions", express.json({ limit: "2mb" }));   // a drawn signature travels as a PNG data URL
app.use(express.json({ limit: "100kb" }));

/* ---------- pages ---------- */
app.get("/engine.js", (req, res) => res.type("application/javascript").sendFile(path.join(__dirname, "engine.js")));
app.get("/admin", (req, res) => res.sendFile(path.join(PUBLIC, "admin.html")));
app.use(express.static(PUBLIC, { extensions: ["html"], maxAge: "1h" }));
app.get("/health", (req, res) => res.json({ ok: true, db: db.kind, engine: ENGINE_VERSION }));

/* ---------- vault: uploads to the staging bucket + team vault API (when configured) ---------- */
const vault = require("./vault-routes")(app, { db, auth, limiter });
const { audit } = require("../vault/lib/audit");
const log = (entry) => (db.pool ? audit(db.pool, entry).catch(e => console.error("audit", e.message)) : Promise.resolve());
app.get("/api/config", (req, res) => res.json({ vault: vault.enabled, maxSampleMb: storage.MAX_MB, maxDirectGb: Number(process.env.MAX_DIRECT_UPLOAD_GB || 5) }));

/* ---------- public API (used by the seller funnel) ---------- */

// Step 4 preview. The browser also computes this locally with the same engine file.
app.post("/api/valuation", limiter(120, 60e3), (req, res) => {
  const a = opt.checkAnswers(req.body && req.body.answers);
  if (!a.ok) return res.status(400).json({ error: a.error });
  res.json(valueDataset(opt.toEngineInput(a.answers)));
});

// Step 5 submit: validate, recompute the estimate on the server, assign folio, save.
app.post("/api/submissions", limiter(20, 10 * 60e3), async (req, res) => {
  try {
    const b = req.body || {};
    const a = opt.checkAnswers(b.answers);
    if (!a.ok) return res.status(400).json({ error: a.error });
    const c = opt.checkContact(b.contact);
    if (!c.ok) return res.status(400).json({ error: c.error });
    if (!Array.isArray(b.manifest) || b.manifest.length !== opt.MANIFEST_ITEMS || !b.manifest.every(x => x === true))
      return res.status(400).json({ error: "every manifest item must be confirmed" });

    const v = valueDataset(opt.toEngineInput(a.answers));
    const uploadToken = crypto.randomBytes(24).toString("hex");
    const row = await db.createSubmission({
      ...a.answers, ...c.contact,
      estimate_low: v.low, estimate_high: v.high, estimate_point: v.point, tier: v.tier, score: v.score,
      breakdown: v.breakdown, engine_version: ENGINE_VERSION,
      lang: b.lang === "es" ? "es" : "en",
      upload_token_hash: crypto.createHash("sha256").update(uploadToken).digest("hex"),
    });
    notify(row).catch(() => {});
    log({ actor: "seller:" + row.folio, action: "submission.signed", folio: row.folio, detail: { track: row.track, estimate: [row.estimate_low, row.estimate_high], ip: req.ip } });
    res.status(201).json({ folio: row.folio, valuation: v, uploadToken });
  } catch (e) {
    console.error("submission failed", e);
    res.status(500).json({ error: "could not save, please try again" });
  }
});

// Step 6 sample upload. Needs the private token returned at submit.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: storage.MAX_MB * 1048576, files: 10 },
  fileFilter: (req, file, cb) => cb(null, storage.allowed(file.originalname)),
});
app.post("/api/submissions/:folio/samples", limiter(40, 10 * 60e3), (req, res, next) => {
  upload.array("files", 10)(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? `file too large (max ${storage.MAX_MB} MB)` : "upload failed" });
    next();
  });
}, async (req, res) => {
  try {
    const folio = String(req.params.folio);
    const token = String(req.get("X-Upload-Token") || "");
    const hash = await db.getUploadTokenHash(folio);
    const given = crypto.createHash("sha256").update(token).digest("hex");
    if (!hash || hash.length !== given.length || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(given)))
      return res.status(403).json({ error: "upload link not valid" });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "no accepted files (allowed: " + storage.ALLOWED.join(" ") + ")" });
    if ((await db.countSamples(folio)) + files.length > 10) return res.status(400).json({ error: "max 10 sample files per folio" });
    const saved = [];
    for (const f of files) {
      const stored = await storage.save(f);
      const id = await db.addSample(folio, { stored_name: stored, original_name: opt.str(f.originalname, 200), size_bytes: f.size, mime: f.mimetype });
      saved.push({ id, name: f.originalname, size: f.size });
    }
    res.status(201).json({ saved });
  } catch (e) {
    console.error("upload failed", e);
    res.status(500).json({ error: "upload failed" });
  }
});

// Feedback box on every step — plus step "general" for the prominent
// top-of-page "Déjanos tu comentario" button (soft launch, Nov 24 2026).
app.post("/api/feedback", limiter(30, 10 * 60e3), async (req, res) => {
  const b = req.body || {};
  const comment = opt.str(b.comment, 500);
  const step = String(b.step || "").slice(0, 10);
  if (!comment || !(/^[1-6]$/.test(step) || step === "general")) return res.status(400).json({ error: "comment and step required" });
  const folio = /^DP-\d{4}-\d{4,}$/.test(b.folio || "") ? b.folio : null;
  try { await db.addFeedback({ step, folio, comment, lang: b.lang === "es" ? "es" : "en" }); res.status(201).json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: "could not save" }); }
});

/* ---------- live chat (soft launch) ----------
   Answers come ONLY from server/chat.js's curated knowledge base (the site's
   own approved copy). Out-of-scope questions get a plain hand-off to
   WhatsApp/email — never an invented answer. Every exchange is logged and
   readable in the team panel. */
app.post("/api/chat", limiter(60, 10 * 60e3), async (req, res) => {
  const b = req.body || {};
  const message = opt.str(b.message, 1000);
  if (!message) return res.status(400).json({ error: "message required" });
  const lang = b.lang === "es" ? "es" : "en";
  try {
    let sid = Number(b.sessionId) || null;
    if (sid && !(await db.chatSessionExists(sid))) sid = null;
    const ans = answerChat(message, lang);
    const v = await db.addChatMessage({ session_id: sid, role: "visitor", text: message, lang, ip: req.ip });
    sid = v.session_id;
    await db.addChatMessage({ session_id: sid, role: "bot", topic: ans.topic, text: ans.text, lang });
    res.json({ sessionId: sid, reply: ans.text, topic: ans.topic, inScope: ans.inScope, handoff: ans.handoff });
  } catch (e) { console.error("chat failed", e); res.status(500).json({ error: "could not save" }); }
});

// "Send by email" — the chat's email escape and the Contact window form.
// The visitor's email is checked with the SAME validator as the funnel
// (server/options.js emailError — a ".jet" ending is rejected).
app.post("/api/contact", limiter(20, 10 * 60e3), async (req, res) => {
  const b = req.body || {};
  const email = opt.str(b.email, 200);
  const message = opt.str(b.message, 2000);
  const name = opt.str(b.name, 160);
  if (!message) return res.status(400).json({ error: "message required" });
  const err = opt.emailError(email);
  if (err === "tld") return res.status(400).json({ error_code: "email_tld", error: "That email ending is not a real domain — for example, .jet is not valid. Did you mean .com? Check the ending (.com, .net, .org…)" });
  if (err) return res.status(400).json({ error_code: "email_format", error: "That email is not in a valid format. It should look like name@company.com, with no spaces." });
  try { await db.addContactMessage({ name, email, message, lang: b.lang === "es" ? "es" : "en" }); res.status(201).json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: "could not save" }); }
});

/* ---------- team panel API (password protected) ---------- */
app.post("/api/admin/login", limiter(8, 60e3), (req, res) => {
  if (!auth.configured()) return res.status(503).json({ error: "ADMIN_PASSWORD is not set on the server" });
  if (!auth.passwordOk((req.body && req.body.password) || "")) { log({ actor: `admin@${req.ip}`, action: "admin.login_failed" }); return res.status(401).json({ error: "wrong password" }); }
  log({ actor: `admin@${req.ip}`, action: "admin.login" });
  auth.issue(res); res.json({ ok: true });
});
app.post("/api/admin/logout", (req, res) => { auth.clear(res); res.json({ ok: true }); });
app.get("/api/admin/me", (req, res) => res.json({ signedIn: auth.isAdmin(req) }));

app.get("/api/admin/submissions", auth.requireAdmin, async (req, res) => res.json(await db.listSubmissions()));
app.get("/api/admin/feedback", auth.requireAdmin, async (req, res) => res.json(await db.listFeedback()));
app.get("/api/admin/chats", auth.requireAdmin, async (req, res) => res.json(await db.listChats()));
app.get("/api/admin/contact-messages", auth.requireAdmin, async (req, res) => res.json(await db.listContactMessages()));
app.patch("/api/admin/submissions/:folio", auth.requireAdmin, async (req, res) => {
  const status = req.body && req.body.status;
  if (!opt.STATUSES.includes(status)) return res.status(400).json({ error: "unknown status" });
  const ok = await db.updateStatus(String(req.params.folio), status);
  if (ok) log({ actor: `admin@${req.ip}`, action: "admin.status", folio: String(req.params.folio), detail: { status } });
  ok ? res.json({ ok: true }) : res.status(404).json({ error: "folio not found" });
});
app.get("/api/admin/samples/:id", auth.requireAdmin, async (req, res) => {
  const s = await db.getSample(req.params.id);
  const p = s && storage.pathOf(s.stored_name);
  if (!p) return res.status(404).json({ error: "file not found" });
  res.download(p, s.original_name);
});

const SUBCOLS = ["folio","created_at","sector","years_in_business","employees","record_years","data_types","record_volume","revenue_band","format","frequency","track","estimate_low","estimate_high","estimate_point","tier","score","breakdown","company_name","owner_name","email","phone","manifest_confirmed","signature_name","signature_method","signature_style","signed_at","sample_file_ref","status"];
const csvCell = v => {
  v = v == null ? "" : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;            // stop spreadsheet formula injection
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
};
app.get("/api/admin/export.:fmt", auth.requireAdmin, async (req, res) => {
  const [subs, fb, chats, contact] = await Promise.all([db.listSubmissions(), db.listFeedback(), db.listChats(), db.listContactMessages()]);
  const day = new Date().toISOString().slice(0, 10);
  if (req.params.fmt === "json") {
    res.setHeader("Content-Disposition", `attachment; filename="data-patrimonio-${day}.json"`);
    return res.json({ submissions: subs.map(r => Object.fromEntries(SUBCOLS.map(c => [c, r[c] ?? null]))), feedback: fb, chats, contact_messages: contact });
  }
  if (req.params.fmt === "csv") {
    const which = ["feedback", "contact"].includes(req.query.table) ? req.query.table : "submissions";
    const cols = which === "feedback" ? ["id","created_at","step","folio","comment"] : which === "contact" ? ["id","created_at","name","email","message"] : SUBCOLS;
    const rows = which === "feedback" ? fb : which === "contact" ? contact : subs;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="data-patrimonio-${which}-${day}.csv"`);
    return res.send("﻿" + [cols.join(","), ...rows.map(r => cols.map(c => csvCell(r[c])).join(","))].join("\n"));
  }
  res.status(404).end();
});

/* ---------- optional alert on every new submission ---------- */
// Set NOTIFY_WEBHOOK_URL to a Slack incoming webhook, Zapier or Make hook,
// and the team gets a message the moment a seller signs.
async function notify(row) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  const text = `Nueva solicitud ${row.folio}: ${row.company_name} (${row.owner_name}) · ${row.track} · $${row.estimate_low.toLocaleString("en-US")}–$${row.estimate_high.toLocaleString("en-US")} · ${row.tier}`;
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, folio: row.folio }) });
}

/* ---------- start ---------- */
async function start() {
  if (process.env.NODE_ENV === "production") {
    if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) throw new Error("Set ADMIN_PASSWORD (12+ characters) before going live.");
    if (!process.env.SESSION_SECRET) throw new Error("Set SESSION_SECRET before going live.");
    if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL (PostgreSQL) before going live.");
  }
  await db.init();
  app.listen(PORT, () => console.log(`DATA Patrimonio running on http://localhost:${PORT}  (database: ${db.kind})`));
}
if (require.main === module) start().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { app, start };
