// ============================================================
// DATA ROOM: the only place buyers ever see data. Separate app,
// separate host/container, separate keys.
// Keys it holds: VIEWING bucket, GET only. No staging, no master,
// no quarantine keys. If this service is broken into, the attacker
// gets read access to the current viewing copies and nothing else.
//
// How viewing works:
//   - the buyer opens an invite link and types an access code sent separately
//   - files are NEVER sent as files: the server renders each page to an
//     image with the viewer's name, email, session and time burned in
//   - no download / copy / print controls exist; the page also blocks them
//   - the browser reports suspicious actions; the server cuts the session,
//     logs it and alerts the team
//   - too many pages too fast (scraping) also cuts the session
// Start: node vault/dataroom/server.js
// ============================================================
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { execFile } = require("child_process");
const express = require("express");
const sharp = require("sharp");
const pg = require("../lib/pg");
const s3 = require("../lib/s3");
const { audit, alert, sha } = require("../lib/audit");
const { splitCsv } = require("../lib/redact");

const app = express();
const PORT = Number(process.env.DATAROOM_PORT || process.env.PORT || 4000);
const PROD = process.env.NODE_ENV === "production";
const IDLE_MIN = Number(process.env.DATAROOM_IDLE_MINUTES || 30);
// MERGE FIX (scrape limit): shipped default is 10 pages/min, aligned with the
// e2e suite's expectation (the suite loads 14 pages in a minute and expects a
// cut; at the old default of 30 the guard never fired inside the test). 10/min
// is ~1 page per 6 seconds — a normal reading pace — and the session cut on
// bulk paging is the security behaviour we want. Raise per engagement via env
// only with a documented reason.
const MAX_PAGES_PER_MIN = Number(process.env.DATAROOM_MAX_PAGES_PER_MIN || 10);
const SEVERE = ["printscreen", "print", "save", "copy", "devtools", "select_all", "drag", "view_source"];
const MAX_WARNINGS = Number(process.env.DATAROOM_MAX_WARNINGS || 10);   // mild events (window blur, tab hidden) before a cut
const pool = pg();
const viewing = () => s3.need("viewing");
const ip = req => req.ip;

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), display-capture=(), clipboard-read=(), clipboard-write=()");
  if (PROD) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  next();
});
app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.get(["/", "/r"], (req, res) => res.sendFile(path.join(__dirname, "public", "room.html")));
app.get("/health", (req, res) => res.json({ ok: true }));

/* ---------- login ---------- */
const loginHits = new Map();
app.post("/api/room/login", async (req, res) => {
  const k = ip(req), now = Date.now(), h = loginHits.get(k) || [];
  const recent = h.filter(t => now - t < 15 * 60e3); recent.push(now); loginHits.set(k, recent);
  if (recent.length > 10) return res.status(429).json({ error: "too many attempts" });
  const invite = String(req.body.invite || ""), code = String(req.body.code || "").trim().toUpperCase();
  const { rows: [v] } = await pool.query(
    `SELECT v.id, v.engagement_id, v.name, v.email, v.code_hash, v.revoked_at, v.failed_logins, e.status AS e_status, e.expires_at, e.buyer_name
     FROM viewers v JOIN engagements e ON e.id=v.engagement_id WHERE v.invite_hash=$1`, [sha(invite)]);
  const generic = () => res.status(401).json({ error: "invalid link or code" });
  if (!v || v.revoked_at) return generic();
  if (v.failed_logins >= 5) return res.status(423).json({ error: "locked: contact DATA Patrimonio" });
  const good = v.code_hash.length === 64 && crypto.timingSafeEqual(Buffer.from(v.code_hash), Buffer.from(sha(code)));
  if (!good) {
    await pool.query(`UPDATE viewers SET failed_logins = failed_logins + 1 WHERE id=$1`, [v.id]);
    await audit(pool, { actor: "viewer:" + v.id, action: "room.login_failed", engagement_id: v.engagement_id, detail: { ip: k } });
    if (v.failed_logins + 1 >= 5) await alert(`🔒 Data room: viewer ${v.email} bloqueado tras 5 códigos incorrectos.`);
    return generic();
  }
  if (v.e_status !== "ready" || new Date(v.expires_at) <= new Date()) return res.status(403).json({ error: "this data room is not open" });

  // one live session per viewer: a new login ends the previous one
  await pool.query(`UPDATE viewer_sessions SET ended_at=now(), end_reason='replaced_by_new_login' WHERE viewer_id=$1 AND ended_at IS NULL`, [v.id]);
  const token = crypto.randomBytes(32).toString("hex"), id = crypto.randomUUID();
  await pool.query(`INSERT INTO viewer_sessions (id, viewer_id, engagement_id, token_hash, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, v.id, v.engagement_id, sha(token), k, String(req.get("user-agent") || "").slice(0, 300)]);
  await pool.query(`UPDATE viewers SET failed_logins=0 WHERE id=$1`, [v.id]);
  await audit(pool, { actor: "viewer:" + v.id, action: "room.login", engagement_id: v.engagement_id, detail: { session: id, ip: k, email: v.email } });
  res.setHeader("Set-Cookie", `dr_session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${12 * 3600}${PROD ? "; Secure" : ""}`);
  res.json({ ok: true });
});

/* ---------- session check on every call ---------- */
async function session(req, res, next) {
  const m = /(?:^|;\s*)dr_session=([0-9a-f]{64})/.exec(req.headers.cookie || "");
  if (!m) return res.status(401).json({ error: "signed out" });
  const { rows: [s] } = await pool.query(
    `SELECT s.*, v.name, v.email, v.revoked_at, e.status AS e_status, e.expires_at, e.buyer_name, e.manifest, e.id AS eid
     FROM viewer_sessions s JOIN viewers v ON v.id=s.viewer_id JOIN engagements e ON e.id=s.engagement_id WHERE s.token_hash=$1`, [sha(m[1])]);
  if (!s || s.ended_at) return res.status(401).json({ error: "session ended", reason: s && s.end_reason });
  const idle = Date.now() - new Date(s.last_seen).getTime() > IDLE_MIN * 60e3;
  const closed = s.revoked_at || s.e_status !== "ready" || new Date(s.expires_at) <= new Date();
  if (idle || closed) {
    await endSession(s, idle ? "idle_timeout" : "engagement_closed", false);
    return res.status(401).json({ error: "session ended", reason: idle ? "idle" : "closed" });
  }
  await pool.query(`UPDATE viewer_sessions SET last_seen=now() WHERE id=$1`, [s.id]);
  req.s = s; next();
}

async function endSession(s, reason, notify, detail = {}) {
  await pool.query(`UPDATE viewer_sessions SET ended_at=now(), end_reason=$2 WHERE id=$1 AND ended_at IS NULL`, [s.id, reason]);
  await audit(pool, { actor: "viewer:" + s.viewer_id, action: notify ? "room.cut" : "room.end", engagement_id: s.engagement_id, detail: { session: s.id, reason, ...detail } });
  if (notify) await alert(`🚨 Data room "${s.buyer_name}": sesión de ${s.email} cortada (${reason}). IP ${s.ip}.`, { session: s.id });
}

app.get("/api/room/me", session, (req, res) => {
  const s = req.s;
  res.json({ name: s.name, email: s.email, buyer: s.buyer_name, session: s.id.slice(0, 8), expires_at: s.expires_at,
    files: (s.manifest || []).map((f, i) => ({ i, name: f.name, type: f.type, pages: f.pages })) });
});

app.post("/api/room/heartbeat", session, (req, res) => res.json({ ok: true }));

app.post("/api/room/event", session, async (req, res) => {
  const type = String(req.body.type || "").slice(0, 40), s = req.s;
  const severe = SEVERE.includes(type);
  await pool.query(`UPDATE viewer_sessions SET warnings = warnings + 1 WHERE id=$1`, [s.id]);
  await audit(pool, { actor: "viewer:" + s.viewer_id, action: "room.attempt." + type, engagement_id: s.engagement_id, detail: { session: s.id, severe } });
  if (severe || s.warnings + 1 >= MAX_WARNINGS) { await endSession(s, severe ? "attempt_" + type : "too_many_warnings", true); return res.json({ cut: true }); }
  res.json({ cut: false });
});

app.post("/api/room/logout", session, async (req, res) => { await endSession(req.s, "logout", false); res.json({ ok: true }); });

/* ---------- page rendering: the only way content leaves this server ---------- */
const xmlEsc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

function watermarkSvg(w, h, s) {
  const stamp = `${s.name} · ${s.email} · ${s.buyer_name} · ${s.id.slice(0, 8)} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const rows = [];
  for (let y = -h; y < h * 2; y += 150) for (let x = -w; x < w * 2; x += 560)
    rows.push(`<text x="${x}" y="${y}" transform="rotate(-28 ${x} ${y})">${xmlEsc(stamp)}</text>`);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <style>text{font:600 17px 'DejaVu Sans',Inter,sans-serif;fill:#0b1a33;fill-opacity:.16}</style>${rows.join("")}
    <rect x="0" y="${h - 26}" width="${w}" height="26" fill="#0b1a33" fill-opacity=".85"/>
    <text x="10" y="${h - 8}" style="font:600 13px 'DejaVu Sans',sans-serif;fill:#e6c452;fill-opacity:1">CONFIDENCIAL · ${xmlEsc(stamp)}</text></svg>`);
}

function tableSvg(lines, header, pageInfo) {
  const W = 1400, rowH = 26, H = 70 + (lines.length + 1) * rowH;
  const cols = header ? splitCsv(header) : null;
  const n = cols ? Math.min(cols.length, 14) : 1, cw = (W - 40) / n;
  const cell = (v, x, y, bold) => `<text x="${x}" y="${y}" style="font:${bold ? 700 : 400} 14px 'DejaVu Sans',sans-serif;fill:#10203c">${xmlEsc(String(v).slice(0, Math.floor(cw / 8.2)))}</text>`;
  let out = `<rect width="${W}" height="${H}" fill="#fff"/><text x="20" y="34" style="font:700 16px 'DejaVu Sans',sans-serif;fill:#0b1a33">${xmlEsc(pageInfo)}</text>`;
  let y = 64;
  if (cols) { out += `<rect x="0" y="${y - 18}" width="${W}" height="${rowH}" fill="#eef1f6"/>` + cols.slice(0, n).map((c, i) => cell(c, 20 + i * cw, y, true)).join(""); y += rowH; }
  for (const l of lines) {
    if (cols) out += splitCsv(l).slice(0, n).map((c, i) => cell(c, 20 + i * cw, y)).join("");
    else out += cell(l, 20, y);
    out += `<line x1="0" x2="${W}" y1="${y + 8}" y2="${y + 8}" stroke="#e3e6ec"/>`; y += rowH;
  }
  return { svg: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${out}</svg>`), W, H };
}

const pdfPage = (buf, page) => new Promise((resolve, reject) => {
  const dir = fs.mkdtempSync(path.join(process.env.DATAROOM_TMP || os.tmpdir(), "dr-"));
  const src = path.join(dir, "in.pdf");
  fs.writeFileSync(src, buf, { mode: 0o600 });
  execFile(process.env.PDFTOPPM || "pdftoppm", ["-f", String(page), "-l", String(page), "-r", "110", "-png", "-singlefile", src, path.join(dir, "out")], { timeout: 30000 }, err => {
    try {
      if (err) return reject(err);
      resolve(fs.readFileSync(path.join(dir, "out.png")));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }       // nothing stays on disk
  });
});

const pageHits = new Map();
app.get("/api/room/page/:i/:p", session, async (req, res) => {
  const s = req.s, f = (s.manifest || [])[Number(req.params.i)], page = Math.max(1, Number(req.params.p) || 1);
  if (!f || page > f.pages) return res.status(404).json({ error: "no such page" });

  // scraping guard
  const now = Date.now(), hits = (pageHits.get(s.id) || []).filter(t => now - t < 60e3); hits.push(now); pageHits.set(s.id, hits);
  if (hits.length > MAX_PAGES_PER_MIN) { await endSession(s, "too_many_pages_per_minute", true, { pages_last_minute: hits.length }); return res.status(401).json({ error: "session ended", reason: "rate" }); }

  try {
    let img;
    const buf = await viewing().getBuffer(f.viewing_key);
    if (f.type === "image") img = await sharp(buf).rotate().resize({ width: 1400, height: 1800, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    else if (f.type === "pdf") img = await pdfPage(buf, page);
    else {
      const all = buf.toString("utf8").split(/\r?\n/);
      const header = f.type === "table" ? all[0] : null, body = f.type === "table" ? all.slice(1) : all;
      const lines = body.slice((page - 1) * 40, page * 40);
      const t = tableSvg(lines, header, `${f.name} · ${page}/${f.pages}`);
      img = await sharp(t.svg).png().toBuffer();
    }
    const meta = await sharp(img).metadata();
    const out = await sharp(img).composite([{ input: watermarkSvg(meta.width, meta.height, s), top: 0, left: 0 }]).png({ compressionLevel: 8 }).toBuffer();
    await pool.query(`UPDATE viewer_sessions SET page_views = page_views + 1 WHERE id=$1`, [s.id]);
    await audit(pool, { actor: "viewer:" + s.viewer_id, action: "view.page", engagement_id: s.engagement_id, folio: f.folio || null, detail: { session: s.id, file: f.name, page } });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", "inline");
    res.send(out);
  } catch (e) {
    console.error("render failed", e.message);
    res.status(500).json({ error: "could not render this page" });
  }
});

// downloads do not exist; anything that looks like one is logged as an attempt
app.all(["/download{*rest}", "/api/room/file{*rest}", "/api/room/raw{*rest}"], async (req, res) => {
  await audit(pool, { actor: "anon", action: "room.attempt.download_url", detail: { path: req.path.slice(0, 200), ip: ip(req) } }).catch(() => {});
  res.status(404).end();
});

// idle sessions are closed even if the viewer never comes back
setInterval(() => pool.query(`UPDATE viewer_sessions SET ended_at=now(), end_reason='idle_timeout' WHERE ended_at IS NULL AND last_seen < now() - ($1 || ' minutes')::interval`, [String(IDLE_MIN)]).catch(() => {}), 60e3).unref();

if (require.main === module) {
  viewing();
  if (s3.role("master") || s3.role("staging") || s3.role("quarantine")) { console.error("REFUSING TO START: the data room must hold VIEWING keys only. Remove MASTER_/STAGING_/QUARANTINE_ variables."); process.exit(1); }
  app.listen(PORT, () => console.log(`data room on http://localhost:${PORT}`));
}
module.exports = { app };
