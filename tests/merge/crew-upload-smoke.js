// ============================================================
// Crew-upload-on-merged-server smoke test.
// Starts the local mock S3 endpoint (tests/merge/mock-s3.js)
// in-process, then starts the REAL merged site server
// (server/index.js) pointed at it with fake B2 credentials, and
// for EACH upload stream (Coastal Pointe Homes marketing, Coastal
// Pointe Homes field, Montana Equipment field):
//   * loads /u/<token> and checks the stream's label is the <h1>,
//   * uploads a 2x5 MiB + 123 byte file in 5 MiB parts via
//     /u/api/init + /u/api/chunk, with a resume check through
//     /u/api/status (ListParts) mid-upload,
//   * verifies via the mock that the object landed byte-exact
//     (sha256) under that stream's <slug>/<subfolder>/ key.
// Also: bad token rejected (page 404, API 403), /u/health reports
// the three streams, and an existing site route (/api/bookings/days)
// still answers in the same process.
// Run:  node tests/merge/crew-upload-smoke.js
// ============================================================
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startMockS3 } = require("./mock-s3");

const ROOT = path.resolve(__dirname, "../..");
const PORT = 18098;
const BASE = `http://127.0.0.1:${PORT}`;
const BUCKET = "crewuploads";
const STREAMS = {
  "tok-cph-marketing-test": { slug: "coastal-pointe-homes", subfolder: "marketing", label: "Coastal Pointe Homes — Marketing Photos & Videos" },
  "tok-cph-field-test": { slug: "coastal-pointe-homes", subfolder: "field", label: "Coastal Pointe Homes — Field Photos" },
  "tok-montana-field-test": { slug: "montana-equipment", subfolder: "field", label: "Montana Equipment — Field Photos" },
};
const CH = 5 * 1024 * 1024; // B2 multipart minimum part size

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function uploadForStream(token, stream, fileName) {
  const tag = `${stream.slug}/${stream.subfolder}`;
  const page = await fetch(`${BASE}/u/${token}`);
  const html = await page.text();
  if (!page.ok || !html.includes(escapeHtml(stream.label))) throw new Error(`[${tag}] upload page did not load with the stream label`);
  if (!html.includes(`<h1>${escapeHtml(stream.label)}</h1>`)) throw new Error(`[${tag}] stream label is not the <h1> heading`);
  if (!html.includes("/u/api/init")) throw new Error(`[${tag}] page does not call the merged /u/api/* endpoints`);
  console.log(`[${tag}] page: OK (heading: ${stream.label})`);

  const data = crypto.randomBytes(CH * 2 + 123);
  const sha = crypto.createHash("sha256").update(data).digest("hex");
  const headers = { "x-upload-token": token };

  const init = await (await fetch(`${BASE}/u/api/init`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ name: fileName, size: data.length, mimeType: "image/jpeg", uploader: "Smoke Test" }),
  })).json();
  if (!init.id) throw new Error(`[${tag}] init failed: ` + JSON.stringify(init));
  console.log(`[${tag}] init: OK`, init.id);

  let offset = 0;
  let dropped = false;
  while (offset < data.length) {
    const end = Math.min(offset + CH, data.length);
    const r = await (await fetch(`${BASE}/u/api/chunk/${init.id}`, {
      method: "PUT", headers: { ...headers, "x-chunk-start": String(offset) }, body: data.subarray(offset, end),
    })).json();
    if (typeof r.offset !== "number") throw new Error(`[${tag}] chunk failed: ` + JSON.stringify(r));
    offset = r.offset;
    if (!dropped && offset >= CH) {
      const st = await (await fetch(`${BASE}/u/api/status/${init.id}`, { headers })).json();
      if (st.offset !== offset) throw new Error(`[${tag}] resume offset mismatch: ${st.offset} != ${offset}`);
      dropped = true;
      console.log(`[${tag}] resume check: OK at offset`, st.offset);
    }
    if (r.complete) break;
  }
  if (!dropped) throw new Error(`[${tag}] resume path never exercised`);
  return { sha, size: data.length, key: `${stream.slug}/${stream.subfolder}/Smoke Test - ${fileName}` };
}

async function main() {
  const mock = await startMockS3();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-merged-smoke-"));
  const child = spawn(process.execPath, [path.join(ROOT, "server/index.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      DATABASE_URL: "",
      ADMIN_PASSWORD: "test-password-123",
      SESSION_SECRET: "test-secret-for-crew-smoke",
      UPLOAD_COMPANIES: JSON.stringify(STREAMS),
      B2_S3_ENDPOINT: `http://127.0.0.1:${mock.port}`,
      B2_S3_REGION: "test-region-1",
      B2_BUCKET: BUCKET,
      B2_KEY_ID: "test-key-id",
      B2_APPLICATION_KEY: "test-application-key-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  child.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  try {
    await waitForHealth();

    const uh = await (await fetch(`${BASE}/u/health`)).json();
    if (!uh.ok || !uh.enabled || uh.bucket !== BUCKET || uh.streams.length !== 3) throw new Error(`/u/health wrong: ${JSON.stringify(uh)}`);
    console.log("/u/health: OK (enabled, bucket crewuploads, 3 streams)");

    const days = await fetch(`${BASE}/api/bookings/days`);
    if (!days.ok) throw new Error(`existing site route /api/bookings/days broke: HTTP ${days.status}`);
    console.log("existing site route /api/bookings/days: OK in the same process");

    const bad = await fetch(`${BASE}/u/not-a-real-token`);
    if (bad.status !== 404) throw new Error(`bad token page check failed: HTTP ${bad.status}`);
    const badApi = await fetch(`${BASE}/u/api/init`, {
      method: "POST", headers: { "x-upload-token": "nope", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x.jpg", size: 10 }),
    });
    if (badApi.status !== 403) throw new Error(`bad token api check failed: HTTP ${badApi.status}`);
    console.log("bad token: rejected OK (page 404, api 403)");

    const expected = [];
    expected.push(await uploadForStream("tok-cph-marketing-test", STREAMS["tok-cph-marketing-test"], "cph-marketing-smoke.jpg"));
    expected.push(await uploadForStream("tok-cph-field-test", STREAMS["tok-cph-field-test"], "cph-field-smoke.jpg"));
    expected.push(await uploadForStream("tok-montana-field-test", STREAMS["tok-montana-field-test"], "montana-field-smoke.jpg"));

    const objects = await (await fetch(`http://127.0.0.1:${mock.port}/__objects__`)).json();
    const keys = Object.keys(objects);
    if (keys.length !== expected.length) throw new Error(`expected ${expected.length} objects in mock bucket, got ${keys.length}: ${keys.join(", ")}`);
    for (const e of expected) {
      const got = objects[e.key];
      if (!got) throw new Error(`object missing under expected key: ${e.key} (have: ${keys.join(", ")})`);
      if (got.bucket !== BUCKET) throw new Error(`${e.key}: wrong bucket ${got.bucket}`);
      if (got.size !== e.size) throw new Error(`${e.key}: size mismatch ${got.size} != ${e.size}`);
      if (got.sha256 !== e.sha) throw new Error(`${e.key}: sha256 mismatch — not byte-exact`);
      console.log(`[${e.key}] byte-exact in mock B2: OK (${got.size} bytes, sha256 ${got.sha256.slice(0, 16)}…)`);
    }
    console.log("CREW-ON-MERGED SMOKE TEST PASSED (merged server + mock B2; all three streams, byte-exact, correct slug/subfolder keys)");
  } finally {
    child.kill();
    mock.server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("merged server did not come up");
}

main().catch((e) => { console.error("CREW-ON-MERGED SMOKE TEST FAILED:", e.message); process.exit(1); });
