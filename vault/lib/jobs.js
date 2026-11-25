// Tiny job queue on Postgres. Several workers can poll safely:
// FOR UPDATE SKIP LOCKED hands each job to exactly one of them.
const os = require("os");
const WORKER = `${os.hostname()}:${process.pid}`;

async function enqueue(pool, type, payload = {}, runAfter = null) {
  const { rows: [r] } = await pool.query(`INSERT INTO jobs (type, payload, run_after) VALUES ($1,$2,coalesce($3, now())) RETURNING id`, [type, JSON.stringify(payload), runAfter]);
  return r.id;
}

async function claim(pool, types) {
  const { rows } = await pool.query(`
    UPDATE jobs SET status='running', attempts=attempts+1, locked_by=$2, locked_at=now()
    WHERE id = (SELECT id FROM jobs WHERE status='queued' AND type = ANY($1) AND run_after <= now()
                ORDER BY run_after, id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING *`, [types, WORKER]);
  return rows[0] || null;
}

const done = (pool, id) => pool.query(`UPDATE jobs SET status='done', last_error=NULL WHERE id=$1`, [id]);

// retry with backoff, give up after 5 attempts
const fail = (pool, job, err) => pool.query(
  `UPDATE jobs SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'queued' END,
     run_after = now() + (interval '1 minute' * power(2, attempts)), last_error=$2 WHERE id=$1`,
  [job.id, String(err && err.message || err).slice(0, 1000)]);

// Jobs stuck in "running" (worker crashed) go back to the queue after 30 minutes
const recover = pool => pool.query(`UPDATE jobs SET status='queued' WHERE status='running' AND locked_at < now() - interval '30 minutes'`);

module.exports = { enqueue, claim, done, fail, recover, WORKER };
