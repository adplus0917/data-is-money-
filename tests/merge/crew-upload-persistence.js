// ============================================================
// Crew-upload SESSION PERSISTENCE test — the restart scenario.
// Mounts the REAL crew-upload router twice against the same mock
// S3 and the same (stub) Postgres pool, with a FRESH module state
// for the second mount — i.e. a server restart. A session created
// and half-uploaded under mount #1 must resume and complete under
// mount #2, and its completion must be recorded in the table.
// The stub pool emulates exactly the SQL the router issues.
// Run:  node tests/merge/crew-upload-persistence.js
// ============================================================
const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { startMockS3 } = require("./mock-s3");

const ROOT = path.resolve(__dirname, "../..");
const TOKEN = "tok-persist-test";
const HEADERS = { "x-upload-token": TOKEN };
const CH = 5 * 1024 * 1024;

/* ---- stub Postgres pool: an in-memory crew_upload_sessions table ---- */
function makeStubPool() {
  const rows = new Map();
  return {
    rows,
    async query(sql, params = []) {
      if (/CREATE TABLE/.test(sql)) return { rows: [] };
      if (/DELETE FROM crew_upload_sessions WHERE state = 'complete'/.test(sql)) return { rows: [] };
      if (/SELECT count/.test(sql)) return { rows: [{ n: [...rows.values()].filter((r) => r.state === "active").length }] };
      if (/INSERT INTO crew_upload_sessions/.test(sql)) {
        const [id, key, upload_id, size, uploader, name] = params;
        if (!rows.has(id)) rows.set(id, { id, key, upload_id, size, uploader, name, state: "active", etag: null, created_at: new Date() });
        return { rows: [] };
      }
      if (/SELECT \* FROM crew_upload_sessions/.test(sql)) { const r = rows.get(params[0]); return { rows: r ? [r] : [] }; }
      if (/UPDATE crew_upload_sessions SET state = 'complete'/.test(sql)) {
        const r = rows.get(params[0]); if (r) { r.state = "complete"; r.etag = params[1]; }
        return { rows: [] };
      }
      if (/DELETE FROM crew_upload_sessions WHERE id/.test(sql)) { rows.delete(params[0]); return { rows: [] }; }
      throw new Error("stub pool: unhandled SQL: " + sql.slice(0, 80));
    },
  };
}

function freshMount(db) {
  const p = path.join(ROOT, "server/crew-upload.js");
  delete require.cache[require.resolve(p)];
  const mount = require(p);
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  mount(app, { limiter: () => (req, res, next) => next(), db });
  return app;
}

async function listen(app) {
  const srv = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  return { srv, base: `http://127.0.0.1:${srv.address().port}` };
}
async function api(base, pathname, opts = {}) {
  const res = await fetch(base + pathname, { ...opts, headers: { ...HEADERS, ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(body.error || ("HTTP " + res.status)); e.status = res.status; throw e; }
  return body;
}

async function main() {
  const mock = await startMockS3();
  process.env.UPLOAD_COMPANIES = JSON.stringify({ [TOKEN]: { slug: "coastal-pointe-homes", subfolder: "field", label: "Persist Test" } });
  process.env.B2_S3_ENDPOINT = `http://127.0.0.1:${mock.port}`;
  process.env.B2_S3_REGION = "test-region-1";
  process.env.B2_BUCKET = "crewuploads";
  process.env.B2_KEY_ID = "k";
  process.env.B2_APPLICATION_KEY = "s";
  const pool = makeStubPool();
  const db = { kind: "postgres", pool };

  const data = crypto.randomBytes(CH + 123);
  const sha = crypto.createHash("sha256").update(data).digest("hex");

  /* ---- mount #1: init + first chunk, then "restart" ---- */
  let sessionId;
  {
    const { srv, base } = await listen(freshMount(db));
    const init = await api(base, "/u/api/init", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "persist.jpg", size: data.length, mimeType: "image/jpeg", uploader: "Persist Test" }) });
    sessionId = init.id;
    const r = await api(base, "/u/api/chunk/" + sessionId, { method: "PUT", headers: { "x-chunk-start": "0" }, body: data.subarray(0, CH) });
    if (r.offset !== CH || r.complete) throw new Error(`mount #1 chunk wrong: ${JSON.stringify(r)}`);
    await new Promise((res) => srv.close(res));
    console.log(`mount #1: session ${sessionId} created, ${CH} bytes landed, server "restarted"`);
  }
  const rowMid = pool.rows.get(sessionId);
  if (!rowMid || rowMid.state !== "active") throw new Error("session row not persisted as active");

  /* ---- mount #2: fresh memory, same DB — resume + complete ---- */
  {
    const { srv, base } = await listen(freshMount(db));
    const st = await api(base, "/u/api/status/" + sessionId);
    if (st.complete) throw new Error("mount #2 status claims complete too early");
    if (st.offset !== CH) throw new Error(`mount #2 resume offset wrong: ${st.offset} != ${CH} (session lost in "restart")`);
    const r = await api(base, "/u/api/chunk/" + sessionId, { method: "PUT", headers: { "x-chunk-start": String(CH) }, body: data.subarray(CH) });
    if (!r.complete) throw new Error(`mount #2 final chunk did not complete: ${JSON.stringify(r)}`);
    const st2 = await api(base, "/u/api/status/" + sessionId);
    if (!st2.complete) throw new Error("mount #2 status after completion is not complete");
    await new Promise((res) => srv.close(res));
    console.log("mount #2: session restored from the table, resumed at the right offset, completed");
  }
  const rowEnd = pool.rows.get(sessionId);
  if (!rowEnd || rowEnd.state !== "complete" || !rowEnd.etag) throw new Error(`completion not recorded in the table: ${JSON.stringify(rowEnd)}`);

  const objects = await (await fetch(`http://127.0.0.1:${mock.port}/__objects__`)).json();
  const key = "coastal-pointe-homes/field/Persist Test - persist.jpg";
  const got = objects[key];
  if (!got || got.sha256 !== sha) throw new Error("object missing or not byte-exact in mock bucket");
  mock.server.close();
  console.log(`PERSISTENCE PASSED: object byte-exact at ${key}; table row state=complete etag=${rowEnd.etag}`);
}

main().catch((e) => { console.error("CREW PERSISTENCE TEST FAILED:", e.message); process.exit(1); });
