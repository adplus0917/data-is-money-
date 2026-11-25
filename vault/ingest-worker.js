// ============================================================
// INGEST WORKER: runs ON THE VAULT RACK.
// Pulls new files from the cloud staging bucket (outbound connection
// only: the rack opens no inbound port), and for each file:
//   1. streams it from staging: SHA-256 + format check + ClamAV
//   2. clean    → copies it to the MASTER bucket (versioned; Object Lock OFF until Andrew's decision — see ops/setup-buckets.js),
//                 re-reads master and checks the SHA-256 matches
//      not clean → copies it to the QUARANTINE bucket, alerts the team
//   3. writes an ingest record + audit entries, then deletes the staging copy
//   4. the folio's corpus stays LOCKED until an admin verifies it
// Keys it holds: staging (GET+DELETE), master (PUT+GET), quarantine (PUT).
// It has NO access to the viewing bucket.
// Start: node vault/ingest-worker.js
// ============================================================
const path = require("path");
const pg = require("./lib/pg");
const s3 = require("./lib/s3");
const { scanStream, sha256Stream } = require("./lib/scan");
const { audit, alert } = require("./lib/audit");
const { xlsxToCsvs } = require("./lib/redact");
const jobs = require("./lib/jobs");

const POLL_MS = Number(process.env.INGEST_POLL_MS || 15000);
const BATCH = Number(process.env.INGEST_BATCH || 5);
const ACTOR = "worker:ingest";

if (process.env.NODE_ENV === "production" && !process.env.CLAMD_HOST)
  throw new Error("CLAMD_HOST is required in production: files must be virus-scanned before they reach the master copy.");

// Stats the team can see to verify a corpus WITHOUT seeing its contents
async function profile(ext, readStream, size) {
  const p = { type: ext, size };
  try {
    if (["csv", "txt", "iif", "qbo", "json"].includes(ext)) {
      let lines = 0, first = "";
      for await (const c of readStream) {
        const s = c.toString("utf8");
        if (!first) first = s.split(/\r?\n/)[0].slice(0, 500);
        for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) lines++;
      }
      p.lines = lines;
      if (ext === "csv") p.columns = first.split(",").map(x => x.replace(/^"|"$/g, "").trim()).slice(0, 60);
    } else if (ext === "xlsx" && size <= 60 * 1048576) {
      const chunks = []; for await (const c of readStream) chunks.push(c);
      const sheets = await xlsxToCsvs(Buffer.concat(chunks), 1e7);
      p.sheets = sheets.map(s => ({ name: s.sheet, rows: s.rows, columns: (s.csv.split("\n")[0] || "").split(",").slice(0, 60) }));
    } else if (ext === "pdf") {
      const chunks = []; for await (const c of readStream) chunks.push(c);
      const m = Buffer.concat(chunks).toString("latin1").match(/\/Type\s*\/Page[^s]/g);
      p.pages_estimate = m ? m.length : null;
    } else if (readStream.destroy) readStream.destroy();
  } catch (e) { p.error = "could not profile"; }
  return p;
}

async function ingestFile(pool, f) {
  const staging = s3.need("staging"), master = s3.need("master"), quarantine = s3.need("quarantine");
  const started = new Date();

  const head = await staging.head(f.staging_key);
  if (!head) {
    // Never uploaded, or staging expired (7-day lifecycle) while the rack was offline
    const old = f.staged_at && Date.now() - new Date(f.staged_at).getTime() > 6.5 * 864e5;
    await pool.query(`UPDATE upload_files SET status='failed', scan_detail=$2 WHERE id=$1`, [f.id, old ? "staging copy expired before ingest" : "file never arrived in staging"]);
    await audit(pool, { actor: ACTOR, action: "ingest.missing", folio: f.folio, detail: { file: f.id, name: f.original_name, expired: old } });
    if (old) await alert(`⚠️ ${f.folio}: archivo "${f.original_name}" expiró en staging antes de llegar al vault. Pedir al vendedor que lo suba otra vez.`);
    return { id: f.id, name: f.original_name, result: "missing" };
  }

  // Pass 1: hash + format + virus scan straight from staging (nothing written yet)
  const scan = await scanStream(await staging.getStream(f.staging_key), f.ext);
  const uploadHashMismatch = f.sha256_upload && f.sha256_upload !== scan.sha256;
  const clean = (scan.scan_status === "clean" || scan.scan_status === "skipped") && !uploadHashMismatch;

  if (!clean) {
    const qkey = `${f.folio}/${f.id}.${f.ext}`;
    await quarantine.put(qkey, await staging.getStream(f.staging_key), { length: Number(head.ContentLength), metadata: { folio: f.folio, file: f.id, reason: scan.scan_status } });
    await staging.del(f.staging_key);
    const detail = uploadHashMismatch ? "checksum changed between upload and staging" : scan.scan_detail;
    await pool.query(`UPDATE upload_files SET status='quarantined', scan_status=$2, scan_detail=$3, sha256_staging=$4, quarantine_key=$5, size_bytes=$6 WHERE id=$1`,
      [f.id, uploadHashMismatch ? "error" : scan.scan_status, detail, scan.sha256, qkey, scan.size]);
    await audit(pool, { actor: ACTOR, action: "ingest.quarantined", folio: f.folio, detail: { file: f.id, name: f.original_name, reason: detail, sha256: scan.sha256 } });
    await alert(`🛑 ${f.folio}: "${f.original_name}" enviado a cuarentena (${detail}).`);
    return { id: f.id, name: f.original_name, size: scan.size, sha256: scan.sha256, quarantine_key: qkey, result: "quarantined" };
  }

  // Pass 2: copy to master. Keys never contain the seller's file name.
  const mkey = `${f.folio}/${f.id}.${f.ext}`;
  await master.put(mkey, await staging.getStream(f.staging_key), {
    length: Number(head.ContentLength), contentType: head.ContentType,
    metadata: { folio: f.folio, file: f.id, sha256: scan.sha256, ingested: started.toISOString() },
  });

  // Pass 3: read master back; the bytes stored must be the bytes scanned
  const mhash = await sha256Stream(await master.getStream(mkey));
  if (mhash !== scan.sha256) {
    await pool.query(`UPDATE upload_files SET scan_detail='master checksum mismatch; staging kept for retry' WHERE id=$1`, [f.id]);
    await audit(pool, { actor: ACTOR, action: "ingest.checksum_mismatch", folio: f.folio, detail: { file: f.id, staging: scan.sha256, master: mhash } });
    throw new Error(`checksum mismatch for ${f.id}`);       // staging copy is NOT deleted; retried next round
  }

  const prof = await profile(f.ext, await master.getStream(mkey), scan.size);
  await staging.del(f.staging_key);
  await pool.query(
    `UPDATE upload_files SET status='ingested', scan_status=$2, scan_detail=$3, sha256_staging=$4, sha256_master=$5, master_key=$6, size_bytes=$7, profile=$8, ingested_at=now() WHERE id=$1`,
    [f.id, scan.scan_status, scan.scan_detail, scan.sha256, mhash, mkey, scan.size, JSON.stringify(prof)]);
  await pool.query(
    `INSERT INTO corpora (folio, status, file_count, total_bytes) VALUES ($1,'locked',1,$2)
     ON CONFLICT (folio) DO UPDATE SET file_count = corpora.file_count + 1, total_bytes = corpora.total_bytes + $2`, [f.folio, scan.size]);
  await audit(pool, { actor: ACTOR, action: "ingest.ok", folio: f.folio, detail: { file: f.id, name: f.original_name, size: scan.size, sha256: scan.sha256, master_key: mkey, scan: scan.scan_status } });
  return { id: f.id, name: f.original_name, size: scan.size, sha256: scan.sha256, master_key: mkey, result: "ingested" };
}

async function round(pool) {
  await jobs.recover(pool);
  // Claim a batch in one short statement; other ingest workers skip these rows.
  // A claim older than 1 hour (crashed worker) can be taken again.
  const { rows: files } = await pool.query(
    `UPDATE upload_files SET claimed_by=$2, claimed_at=now()
     WHERE id IN (SELECT id FROM upload_files WHERE status='in_staging'
                    AND (claimed_at IS NULL OR claimed_at < now() - interval '1 hour')
                  ORDER BY staged_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING *`, [BATCH, jobs.WORKER]);
  if (!files.length) return 0;
  const started = new Date(), results = [];
  for (const f of files) {
    try { results.push(await ingestFile(pool, f)); }
    catch (e) {
      console.error("ingest error", f.id, e.message);
      // retry in about 5 minutes
      await pool.query(`UPDATE upload_files SET claimed_at = now() - interval '55 minutes' WHERE id=$1`, [f.id]);
      results.push({ id: f.id, name: f.original_name, result: "retry", error: e.message });
    }
  }
  for (const folio of [...new Set(files.map(f => f.folio))]) {
    const mine = results.filter(r => files.find(f => f.id === r.id).folio === folio);
    await pool.query(`INSERT INTO ingest_records (folio, started_at, files, result) VALUES ($1,$2,$3,$4)`,
      [folio, started, JSON.stringify(mine), mine.every(r => r.result === "ingested") ? "ok" : "partial"]);
    // first sample in → the sales pipeline status moves forward by itself
    await pool.query(`UPDATE submissions SET status='Muestra recibida' WHERE folio=$1 AND status='Nuevo' AND EXISTS (SELECT 1 FROM upload_files WHERE folio=$1 AND status='ingested')`, [folio]);
  }
  return files.length;
}

async function main() {
  const pool = pg();
  s3.need("staging"); s3.need("master"); s3.need("quarantine");
  if (s3.role("viewing")) console.warn("WARNING: the ingest worker should not hold VIEWING_* keys. Remove them from its environment.");
  console.log(`ingest worker up · polling every ${POLL_MS / 1000}s · clamd ${process.env.CLAMD_HOST ? "on" : "OFF (dev only)"}`);
  const once = process.argv.includes("--once");
  for (;;) {
    let n = 0;
    try { n = await round(pool); if (n) console.log(`ingested batch of ${n}`); }
    catch (e) { console.error("round failed:", e.message); }
    if (once && !n) break;
    if (!n) await new Promise(r => setTimeout(r, POLL_MS));
  }
  await pool.end();
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { round, ingestFile };
