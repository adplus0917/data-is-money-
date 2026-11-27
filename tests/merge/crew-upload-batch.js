// ============================================================
// Crew-upload MASS BATCH test — the Nov 27 2026 collapse scenario.
// Starts the mock S3 endpoint + the REAL merged site server, then
// runs a 150-file batch from ONE client (one IP) through the flow
// the rebuilt page uses: sessions created just-in-time, at most 2
// files in flight, relay chunks with the server's confirmed offset.
// The old code failed this by construction: init was rate-limited
// to 60 per 10 min per IP (files 61+ died before starting) and the
// session ceiling was 800. Asserts: 150/150 complete, ZERO 429s,
// every object byte-exact in the mock bucket under the right key.
// Run:  node tests/merge/crew-upload-batch.js
// ============================================================
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startMockS3 } = require("./mock-s3");

const ROOT = path.resolve(__dirname, "../..");
const PORT = 18100 + Math.floor(Math.random() * 800); // random per run: an orphaned server from a killed run must never be mistaken for ours
const BASE = `http://127.0.0.1:${PORT}`;
const BUCKET = "crewuploads";
const TOKEN = "tok-cph-marketing-test";
const STREAMS = { [TOKEN]: { slug: "coastal-pointe-homes", subfolder: "marketing", label: "Coastal Pointe Homes — Marketing Photos & Videos" } };
const N = 150;
const HEADERS = { "x-upload-token": TOKEN };
let count429 = 0;

async function api(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, { ...opts, headers: { ...HEADERS, ...(opts.headers || {}) } });
  if (res.status === 429) count429++;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(body.error || ("HTTP " + res.status)); e.status = res.status; throw e; }
  return body;
}

async function uploadOne(i) {
  const size = 120 * 1024 + (i * 7919) % (280 * 1024);
  const data = crypto.randomBytes(size);
  const sha = crypto.createHash("sha256").update(data).digest("hex");
  const name = `batch-${String(i + 1).padStart(3, "0")}.jpg`;
  const init = await api("/u/api/init", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, size, mimeType: "image/jpeg", uploader: "Batch Test" }) });
  const st = await api("/u/api/status/" + init.id);
  if (st.complete) throw new Error(`file ${name}: status claims complete before any bytes`);
  let offset = st.offset || 0;
  while (offset < size) {
    const end = Math.min(offset + 8 * 1024 * 1024, size);
    const r = await api("/u/api/chunk/" + init.id, { method: "PUT", headers: { "x-chunk-start": String(offset) }, body: data.subarray(offset, end) });
    if (typeof r.offset !== "number") throw new Error(`file ${name}: bad chunk response ${JSON.stringify(r)}`);
    offset = r.offset;
    if (r.complete) break;
  }
  const done = await api("/u/api/status/" + init.id);
  if (!done.complete) throw new Error(`file ${name}: not complete after final chunk`);
  return { key: `coastal-pointe-homes/marketing/Batch Test - ${name}`, sha, size };
}

async function main() {
  const mock = await startMockS3();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-batch-"));
  const child = spawn(process.execPath, [path.join(ROOT, "server/index.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, DATABASE_URL: "", ADMIN_PASSWORD: "x", SESSION_SECRET: "y",
      UPLOAD_COMPANIES: JSON.stringify(STREAMS), B2_S3_ENDPOINT: `http://127.0.0.1:${mock.port}`,
      B2_S3_REGION: "test-region-1", B2_BUCKET: BUCKET, B2_KEY_ID: "k", B2_APPLICATION_KEY: "s" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server-err] ${d}`)); child.stdout.on("data", (d) => process.stdout.write(`[server-out] ${d}`));
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { const uh = await (await fetch(`${BASE}/u/health`)).json(); if (uh.enabled && uh.bucket === BUCKET) up = true; } catch {}
      if (!up) await new Promise((r) => setTimeout(r, 200));
    }
    if (!up) throw new Error("server did not come up with the crew-upload config this test set");
    const t0 = Date.now();
    const expected = [];
    let idx = 0, failed = 0;
    async function worker() {
      while (idx < N) {
        const i = idx++;
        try { expected.push(await uploadOne(i)); }
        catch (e) { failed++; console.error(`file ${i + 1} FAILED: ${e.message}`); }
      }
    }
    await Promise.all([worker(), worker()]); // the rebuilt page's concurrency: 2
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (failed) throw new Error(`${failed}/${N} files failed`);
    if (count429) throw new Error(`${count429} HTTP 429 responses during the batch (old init cap was 60/10min/IP)`);
    const objects = await (await fetch(`http://127.0.0.1:${mock.port}/__objects__`)).json();
    for (const e of expected) {
      const got = objects[e.key];
      if (!got) throw new Error(`missing object ${e.key}`);
      if (got.size !== e.size || got.sha256 !== e.sha) throw new Error(`not byte-exact: ${e.key}`);
    }
    const totalMB = (expected.reduce((n, e) => n + e.size, 0) / 1048576).toFixed(1);
    console.log(`BATCH PASSED: ${N}/${N} files complete, 0 HTTP 429, all byte-exact (${totalMB} MB in ${secs}s through the relay, 2 in flight)`);
  } finally {
    child.kill("SIGKILL"); mock.server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error("CREW BATCH TEST FAILED:", e.message); process.exit(1); });
