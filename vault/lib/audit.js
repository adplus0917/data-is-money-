// Append-only audit log. The database trigger computes the hash chain;
// this file only inserts and reads. Nothing in the app can UPDATE or DELETE it.
const crypto = require("crypto");

async function audit(pool, { actor, action, folio = null, engagement_id = null, detail = {} }) {
  await pool.query(`INSERT INTO audit_log (actor, action, folio, engagement_id, detail) VALUES ($1,$2,$3,$4,$5)`,
    [actor, action, folio, engagement_id, JSON.stringify(detail)]);
}

async function query(pool, { folio, action, actor, engagement, since, limit = 200 } = {}) {
  const w = [], v = [];
  if (folio) { v.push(folio); w.push(`folio = $${v.length}`); }
  if (action) { v.push(action + "%"); w.push(`action LIKE $${v.length}`); }
  if (actor) { v.push(actor + "%"); w.push(`actor LIKE $${v.length}`); }
  if (engagement) { v.push(engagement); w.push(`engagement_id = $${v.length}`); }
  if (since) { v.push(since); w.push(`at >= $${v.length}`); }
  v.push(Math.min(Number(limit) || 200, 2000));
  const { rows } = await pool.query(`SELECT * FROM audit_log ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY id DESC LIMIT $${v.length}`, v);
  return rows;
}

// Recompute the whole chain in Postgres; returns the first broken row, if any.
async function verifyChain(pool) {
  const { rows } = await pool.query(`
    WITH c AS (
      SELECT id, hash, prev_hash, lag(hash) OVER (ORDER BY id) AS real_prev,
        encode(sha256(convert_to(coalesce(prev_hash,'') || '|' || to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || '|' ||
          actor || '|' || action || '|' || coalesce(folio,'') || '|' || coalesce(engagement_id::text,'') || '|' || detail::text,'UTF8')),'hex') AS recomputed
      FROM audit_log)
    SELECT count(*)::int AS total,
      min(id) FILTER (WHERE hash <> recomputed OR coalesce(prev_hash,'') <> coalesce(real_prev,'')) AS first_broken
    FROM c`);
  return { ok: rows[0].first_broken == null, total: rows[0].total, first_broken: rows[0].first_broken };
}

async function alert(text, extra = {}) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  try { await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, ...extra }) }); } catch (e) {}
}

const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");

module.exports = { audit, query, verifyChain, alert, sha };
