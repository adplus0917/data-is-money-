// ============================================================
// VIEWING-COPY BUILDER: runs ON THE VAULT RACK.
// Jobs it takes from the queue:
//   build_engagement  {engagement_id}  → derive a viewing copy from master
//   close_engagement  {engagement_id, reason}  → delete that viewing copy
//   expire_sweep      {}               → close every engagement past its end date
// Keys it holds: master (GET only), viewing (PUT + DELETE).
// It can never write or delete master objects (its MinIO policy forbids it).
// Start: node vault/viewing-builder.js
// ============================================================
const pg = require("./lib/pg");
const s3 = require("./lib/s3");
const jobs = require("./lib/jobs");
const { audit, alert } = require("./lib/audit");
const { redactText, xlsxToCsvs, TEXT_TYPES } = require("./lib/redact");

const POLL_MS = Number(process.env.BUILDER_POLL_MS || 10000);
const ACTOR = "worker:builder";
const ALLOW_INTERNAL = process.env.ALLOW_INTERNAL_REVIEW === "true";
const IMAGE_TYPES = ["png", "jpg", "jpeg"];
const VIEWABLE = ["pdf", ...IMAGE_TYPES, ...TEXT_TYPES, "xlsx"];

async function build(pool, id) {
  const master = s3.need("master"), viewing = s3.need("viewing");
  const { rows: [e] } = await pool.query(`SELECT * FROM engagements WHERE id=$1`, [id]);
  if (!e) throw new Error("engagement not found");
  if (!["requested", "failed", "building"].includes(e.status)) return;
  if (new Date(e.expires_at) <= new Date()) throw new Error("engagement already expired");

  // VERIFICATION GATE: nothing is viewable before an admin verifies the corpus
  const { rows: corp } = await pool.query(`SELECT folio, status FROM corpora WHERE folio = ANY($1)`, [e.folios]);
  const notVerified = e.folios.filter(f => !corp.find(c => c.folio === f && c.status === "verified"));
  if (notVerified.length && !(e.kind === "internal_review" && ALLOW_INTERNAL)) {
    await pool.query(`UPDATE engagements SET status='failed', last_error=$2 WHERE id=$1`, [id, "not verified: " + notVerified.join(", ")]);
    await audit(pool, { actor: ACTOR, action: "build.blocked_unverified", engagement_id: id, detail: { folios: notVerified } });
    return;
  }

  await pool.query(`UPDATE engagements SET status='building', last_error=NULL WHERE id=$1`, [id]);
  await viewing.deletePrefix(e.viewing_prefix);          // rebuilds start clean
  const { rows: files } = await pool.query(
    `SELECT * FROM upload_files WHERE folio = ANY($1) AND status='ingested' ORDER BY folio, created_at`, [e.folios]);

  const redact = e.redaction && e.redaction.mode === "pii";
  const manifest = [], withheld = [];
  let redactions = 0;

  for (const f of files) {
    const ext = f.ext;
    if (!VIEWABLE.includes(ext)) { withheld.push({ file: f.id, name: f.original_name, reason: `.${ext} cannot be shown in the view-only room` }); continue; }
    if (redact && !TEXT_TYPES.includes(ext) && ext !== "xlsx") {
      withheld.push({ file: f.id, name: f.original_name, reason: "redaction required; this file type cannot be redacted automatically (review by hand)" });
      continue;
    }
    if (TEXT_TYPES.includes(ext) || ext === "xlsx") {
      const buf = await master.getBuffer(f.master_key);
      const parts = ext === "xlsx" ? (await xlsxToCsvs(buf)).map(s => ({ label: s.sheet, text: s.csv }))
                                   : [{ label: null, text: buf.toString("utf8") }];
      parts.forEach((p, i) => {
        let text = p.text;
        if (redact) { const r = redactText(text, e.redaction); text = r.text; redactions += r.count; }
        const vkey = `${e.viewing_prefix}${f.id}${parts.length > 1 ? "-" + i : ""}.${ext === "xlsx" || ext === "csv" ? "csv" : "txt"}`;
        p.key = vkey; p.out = text;
      });
      for (const p of parts) {
        await viewing.put(p.key, Buffer.from(p.out, "utf8"), { contentType: "text/plain; charset=utf-8", metadata: { engagement: e.id, source: f.id } });
        const rows = p.out.split("\n").length;
        manifest.push({ id: `${f.id}${p.label ? ":" + p.label : ""}`, name: f.original_name + (p.label ? ` · ${p.label}` : ""), type: ext === "xlsx" || ext === "csv" ? "table" : "text", viewing_key: p.key, pages: Math.max(1, Math.ceil(rows / 40)), folio: f.folio });
      }
    } else {
      // PDFs and images with redaction mode "none": server-side copy, bytes never pass through this process
      const vkey = `${e.viewing_prefix}${f.id}.${ext}`;
      if (process.env.MASTER_S3_ENDPOINT && process.env.MASTER_S3_ENDPOINT === process.env.VIEWING_S3_ENDPOINT)
        await viewing.copyFrom(master.bucket, f.master_key, vkey, { engagement: e.id, source: f.id });
      else                                             // separate storage servers: stream master → viewing
        await viewing.put(vkey, await master.getStream(f.master_key), { length: Number(f.size_bytes), metadata: { engagement: e.id, source: f.id } });
      const pages = ext === "pdf" ? Math.max(1, (f.profile && f.profile.pages_estimate) || 1) : 1;
      manifest.push({ id: f.id, name: f.original_name, type: ext === "pdf" ? "pdf" : "image", viewing_key: vkey, pages, folio: f.folio });
    }
  }

  await pool.query(`UPDATE engagements SET status='ready', manifest=$2, withheld=$3, built_at=now() WHERE id=$1`,
    [id, JSON.stringify(manifest), JSON.stringify(withheld)]);
  await audit(pool, { actor: ACTOR, action: "build.ready", engagement_id: id, detail: { files: manifest.length, withheld: withheld.length, redactions, buyer: e.buyer_name, expires_at: e.expires_at } });
  if (withheld.length) await alert(`ℹ️ Data room "${e.buyer_name}": ${withheld.length} archivo(s) no incluidos (ver panel).`);
}

async function close(pool, id, reason) {
  const viewing = s3.need("viewing");
  const { rows: [e] } = await pool.query(`SELECT * FROM engagements WHERE id=$1`, [id]);
  if (!e || ["expired", "revoked"].includes(e.status) && e.closed_at) return;
  const deleted = await viewing.deletePrefix(e.viewing_prefix);     // viewing copy only; master untouched
  await pool.query(`UPDATE viewer_sessions SET ended_at=now(), end_reason=$2 WHERE engagement_id=$1 AND ended_at IS NULL`, [id, "engagement_" + reason]);
  await pool.query(`UPDATE engagements SET status=$2, closed_at=now() WHERE id=$1`, [id, reason === "revoked" ? "revoked" : "expired"]);
  await audit(pool, { actor: ACTOR, action: "engagement." + reason, engagement_id: id, detail: { deleted_objects: deleted, buyer: e.buyer_name } });
}

async function sweep(pool) {
  const { rows } = await pool.query(`SELECT id FROM engagements WHERE expires_at <= now() AND status IN ('requested','building','ready','failed')`);
  for (const r of rows) await close(pool, r.id, "expired");
  // revoked engagements whose copy wasn't deleted yet
  const { rows: rv } = await pool.query(`SELECT id FROM engagements WHERE status='revoked' AND closed_at IS NULL`);
  for (const r of rv) await close(pool, r.id, "revoked");
  return rows.length + rv.length;
}

async function handle(pool, job) {
  if (job.type === "build_engagement") return build(pool, job.payload.engagement_id);
  if (job.type === "close_engagement") return close(pool, job.payload.engagement_id, job.payload.reason || "revoked");
  if (job.type === "expire_sweep") return sweep(pool);
}

async function main() {
  const pool = pg();
  s3.need("master"); s3.need("viewing");
  if (s3.role("staging") || s3.role("quarantine")) console.warn("WARNING: the builder should only hold MASTER (read) and VIEWING keys.");
  console.log(`viewing builder up · polling every ${POLL_MS / 1000}s · internal review ${ALLOW_INTERNAL ? "ON" : "off"}`);
  const once = process.argv.includes("--once");
  let lastSweep = 0;
  for (;;) {
    if (Date.now() - lastSweep > 10 * 60e3) { try { await sweep(pool); } catch (e) { console.error("sweep:", e.message); } lastSweep = Date.now(); }
    const job = await jobs.claim(pool, ["build_engagement", "close_engagement", "expire_sweep"]).catch(e => { console.error(e.message); return null; });
    if (job) {
      try { await handle(pool, job); await jobs.done(pool, job.id); }
      catch (e) {
        console.error("job failed", job.id, e.message);
        await jobs.fail(pool, job, e);
        if (job.type === "build_engagement") await pool.query(`UPDATE engagements SET status='failed', last_error=$2 WHERE id=$1`, [job.payload.engagement_id, e.message]);
      }
      continue;
    }
    if (once) break;
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  await pool.end();
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { build, close, sweep };
