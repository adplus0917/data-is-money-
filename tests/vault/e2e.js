const fs = require("fs"); const { execSync } = require("child_process");
const path = require("path");
process.chdir(__dirname);
const W = "http://localhost:3100", R = "http://localhost:4100", ROOT = path.resolve(__dirname, "../..");
const ENV = "cd " + ROOT + " && . " + path.join(__dirname, "env.sh") + " && ";
const sh = c => execSync(ENV + c, { shell: "/bin/bash", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const psql = q => execSync(`psql -h localhost -p 5433 -U postgres dp2 -At -c "${q.replace(/"/g, '\\"')}"`, { encoding: "utf8" }).trim();
let adminCookie = "", roomCookie = "";
const j = async (url, opt = {}) => { const r = await fetch(url, opt); const t = await r.text(); let b; try { b = JSON.parse(t) } catch { b = t } return { s: r.status, b, h: r.headers }; };
const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) process.exitCode = 1; };
const form = (files) => { const fd = new FormData(); for (const f of files) fd.append("files", new Blob([fs.readFileSync("files/" + f)]), f); return fd; };

(async () => {
  const answers = { sector: "roof", years_in_business: "over10", employees: "26to50", record_years: "5to10", data_types: ["invoices", "email", "accounting"], record_volume: "10kto50k", revenue_band: "5to10m", format: "digital_structured", frequency: "ongoing", track: "licencia" };
  const contact = { company_name: "Techos Gómez LLC", owner_name: "Luis Gómez", email: "luis@example.com", signature_name: "Luis Gómez" };
  const sub = await j(W + "/api/submissions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers, contact, manifest: [true, true, true, true, true] }) });
  const { folio, uploadToken: tok } = sub.b; ok(sub.s === 201, "submit → " + folio);
  const H = { "X-Upload-Token": tok };

  // 1. small files through the website (scanned + hashed there)
  let r = await j(`${W}/api/submissions/${folio}/samples`, { method: "POST", headers: H, body: form(["clientes.csv", "ar-aging.xlsx", "eicar.txt", "fake.pdf"]) });
  ok(r.s === 201 && r.b.saved.length === 2, `web upload: ${r.b.saved && r.b.saved.map(s => s.name)} saved`);
  ok(r.b.rejected && r.b.rejected.length === 2, `web upload rejected: ${JSON.stringify(r.b.rejected)}`);
  r = await j(`${W}/api/submissions/${folio}/samples`, { method: "POST", headers: { "X-Upload-Token": "bad" }, body: form(["clientes.csv"]) });
  ok(r.s === 403, "wrong upload token refused");

  // 2. large-file path: presigned PUT straight to staging, then complete
  for (const name of ["contrato.pdf", "eicar.txt"]) {
    const buf = fs.readFileSync("files/" + name);
    r = await j(`${W}/api/submissions/${folio}/uploads`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "corpus", files: [{ name, size: buf.length }] }) });
    const slot = r.b.files[0];
    const put = await fetch(slot.url, { method: "PUT", headers: slot.headers, body: buf });
    const c = await j(`${W}/api/submissions/${folio}/uploads/${slot.id}/complete`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: "{}" });
    ok(put.ok && c.s === 200, `direct upload ${name} → staging (${put.status})`);
  }
  ok(psql(`select count(*) from upload_files where folio='${folio}' and status='in_staging'`) === "4", "4 files waiting in staging");

  // 3. ingest worker on the rack
  sh("st; ma; qu; export CLAMD_HOST=localhost DATABASE_URL=postgres://dp_ingest@localhost:5433/dp2; node vault/ingest-worker.js --once");
  const rows = psql(`select original_name||':'||status||':'||scan_status||':'||(sha256_staging=sha256_master)::text from upload_files where folio='${folio}' order by original_name`);
  console.log("     " + rows.replace(/\n/g, "\n     "));
  ok(psql(`select count(*) from upload_files where folio='${folio}' and status='ingested' and sha256_staging=sha256_master and coalesce(sha256_upload,sha256_staging)=sha256_staging`) === "3", "3 clean files in master, staging hash = master hash = upload hash");
  ok(psql(`select status from upload_files where folio='${folio}' and original_name='eicar.txt'`) === "quarantined", "virus found at ingest → quarantine");
  const stagingLeft = sh("st; node -e \"require('./vault/lib/s3').need('staging').list('').then(l=>console.log(l.length))\"").trim();
  ok(stagingLeft === "0", "staging emptied after ingest (" + stagingLeft + " objects left)");
  ok(psql(`select status from corpora where folio='${folio}'`) === "locked", "corpus LOCKED until verified");
  ok(psql(`select status from submissions where folio='${folio}'`) === "Muestra recibida", "pipeline status moved to 'Muestra recibida'");
  console.log("     profile: " + psql(`select profile::text from upload_files where folio='${folio}' and ext='csv'`));

  // 4. admin: engagement before verification must be blocked
  r = await fetch(W + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test-password-123" }) });
  adminCookie = r.headers.get("set-cookie").split(";")[0];
  const A = (m, u, b) => j(W + u, { method: m, headers: { Cookie: adminCookie, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  const exp = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  r = await A("POST", "/api/admin/vault/engagements", { buyer_name: "Lab Alfa", folios: folio, kind: "buyer", redaction_mode: "pii", columns: "Cliente", expires_at: exp });
  const e1 = r.b.id;
  sh("ma; vi; export DATABASE_URL=postgres://dp_builder@localhost:5433/dp2; node vault/viewing-builder.js --once");
  ok(psql(`select status from engagements where id='${e1}'`) === "failed", "build BLOCKED before verification: " + psql(`select last_error from engagements where id='${e1}'`));

  // 5. verify → rebuild → viewing copy
  r = await A("POST", `/api/admin/vault/corpora/${folio}/verify`, { note: "sample matches manifest" });
  ok(r.s === 200, "admin verified corpus");
  await A("POST", `/api/admin/vault/engagements/${e1}/rebuild`);
  sh("ma; vi; export DATABASE_URL=postgres://dp_builder@localhost:5433/dp2; node vault/viewing-builder.js --once");
  const e1row = JSON.parse(psql(`select row_to_json(e) from engagements e where id='${e1}'`));
  ok(e1row.status === "ready", `viewing copy ready: ${e1row.manifest.length} files shown, ${e1row.withheld.length} withheld (${e1row.withheld.map(w => w.name + ": " + w.reason).join("; ")})`);
  const vkeys = sh("vi; node -e \"require('./vault/lib/s3').need('viewing').list('eng-" + e1 + "/').then(l=>console.log(l.map(o=>o.Key).join(' ')))\"").trim();
  const csvKey = e1row.manifest.find(m => m.name === "clientes.csv").viewing_key;
  const red = sh(`vi; node -e "require('./vault/lib/s3').need('viewing').getBuffer('${csvKey}').then(b=>console.log(b.toString()))"`);
  ok(!/123-45-6789|4111 1111|juan@example|813-555-0142|Juan Perez/.test(red), "viewing copy redacted (SSN, card, email, phone, Cliente column)");
  console.log("     " + red.trim().split("\n").slice(0, 2).join("\n     "));
  const masterCsv = sh(`ma; node -e "require('./vault/lib/s3').need('master').getBuffer('${psql(`select master_key from upload_files where folio='${folio}' and ext='csv'`)}').then(b=>console.log(b.toString()))"`);
  ok(/123-45-6789/.test(masterCsv), "master copy untouched (original still complete)");

  // second engagement without redaction so the PDF is viewable
  r = await A("POST", "/api/admin/vault/engagements", { buyer_name: "Lab Beta", folios: folio, kind: "buyer", redaction_mode: "none", expires_at: exp });
  const e2 = r.b.id; sh("ma; vi; export DATABASE_URL=postgres://dp_builder@localhost:5433/dp2; node vault/viewing-builder.js --once");
  ok(psql(`select status from engagements where id='${e2}'`) === "ready", "engagement 2 (no redaction) ready, separate folder eng-" + e2.slice(0, 8));

  // 6. invite + data room
  r = await A("POST", `/api/admin/vault/engagements/${e1}/viewers`, { name: "Ana Buyer", email: "ana@labalfa.ai" });
  const invite = r.b.link.split("#")[1], code = r.b.code; ok(r.s === 201 && code.length === 8, "invite link + code created (shown once)");
  r = await j(R + "/api/room/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invite, code: "WRONGCOD" }) });
  ok(r.s === 401, "wrong access code refused");
  r = await fetch(R + "/api/room/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invite, code }) });
  roomCookie = r.headers.get("set-cookie").split(";")[0]; ok(r.ok, "viewer signed in");
  const RC = { Cookie: roomCookie };
  const me = await j(R + "/api/room/me", { headers: RC }); ok(me.s === 200, "room lists files: " + me.b.files.map(f => f.name + `(${f.pages}p)`).join(", "));
  const ti = me.b.files.findIndex(f => f.name === "clientes.csv");
  let pg = await fetch(`${R}/api/room/page/${ti}/1`, { headers: RC }); const png = Buffer.from(await pg.arrayBuffer());
  fs.writeFileSync(__dirname + "/out-room-table.png", png);
  ok(pg.ok && pg.headers.get("content-type") === "image/png" && pg.headers.get("cache-control") === "no-store", "page served as watermarked PNG, no-store");
  const xi = me.b.files.findIndex(f => f.name.startsWith("ar-aging"));
  pg = await fetch(`${R}/api/room/page/${xi}/1`, { headers: RC }); fs.writeFileSync(__dirname + "/out-room-xlsx.png", Buffer.from(await pg.arrayBuffer())); ok(pg.ok, "xlsx sheet page rendered");
  ok((await fetch(`${R}/download/x`, { headers: RC })).status === 404, "no download route exists (attempt logged)");

  // pdf in engagement 2
  r = await A("POST", `/api/admin/vault/engagements/${e2}/viewers`, { name: "Ben", email: "ben@labbeta.ai" });
  let rr = await fetch(R + "/api/room/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invite: r.b.link.split("#")[1], code: r.b.code }) });
  const RC2 = { Cookie: rr.headers.get("set-cookie").split(";")[0] };
  const me2 = await j(R + "/api/room/me", { headers: RC2 });
  const pi = me2.b.files.findIndex(f => f.type === "pdf");
  pg = await fetch(`${R}/api/room/page/${pi}/1`, { headers: RC2 }); fs.writeFileSync(__dirname + "/out-room-pdf.png", Buffer.from(await pg.arrayBuffer())); ok(pg.ok, "PDF page rendered as watermarked image");

  // 7. monitoring: a copy attempt cuts the session
  r = await j(R + "/api/room/event", { method: "POST", headers: { ...RC, "Content-Type": "application/json" }, body: JSON.stringify({ type: "copy" }) });
  ok(r.b.cut === true, "copy attempt → session cut");
  ok((await fetch(`${R}/api/room/page/${ti}/1`, { headers: RC })).status === 401, "cut session can't load pages");
  // scraping guard on viewer 2
  let codes = [];
  for (let i = 0; i < 14; i++) codes.push((await fetch(`${R}/api/room/page/${pi}/1`, { headers: RC2 })).status);
  ok(codes.includes(401), "too many pages per minute → session cut (" + codes.join(",") + ")");

  // 8. expiry: viewing copy deleted, master kept
  psql(`select 1`);
  execSync(`psql -h localhost -p 5433 -U postgres dp2 -c "update engagements set expires_at=now()-interval '1 minute' where id='${e1}'"`);
  sh("ma; vi; export DATABASE_URL=postgres://dp_builder@localhost:5433/dp2; node vault/viewing-builder.js --once");
  ok(psql(`select status from engagements where id='${e1}'`) === "expired", "engagement expired by sweeper");
  const left = sh("vi; node -e \"require('./vault/lib/s3').need('viewing').list('eng-" + e1 + "/').then(l=>console.log(l.length))\"").trim();
  ok(left === "0", "expired viewing copy deleted (" + left + " objects left)");
  const mcount = sh("ma; node -e \"require('./vault/lib/s3').need('master').list('" + folio + "/').then(l=>console.log(l.length))\"").trim();
  ok(mcount === "3", "master still has all 3 files");
  // revoke engagement 2
  await A("POST", `/api/admin/vault/engagements/${e2}/revoke`);
  sh("ma; vi; export DATABASE_URL=postgres://dp_builder@localhost:5433/dp2; node vault/viewing-builder.js --once");
  ok(psql(`select status||':'||(closed_at is not null)::text from engagements where id='${e2}'`) === "revoked:true", "revoked engagement closed and its copy deleted");

  // 9. audit log
  let chain = (await A("GET", "/api/admin/vault/audit/verify")).b; ok(chain.ok, `audit chain intact (${chain.total} entries)`);
  let tamper = ""; try { execSync(`psql -h localhost -p 5433 -U postgres dp2 -c "update audit_log set actor='x' where id=1"`, { stdio: "pipe" }); } catch (e) { tamper = e.stderr.toString(); }
  ok(/append-only/.test(tamper), "UPDATE on audit_log refused");
  try { execSync(`psql -h localhost -p 5433 -U postgres dp2 -c "delete from audit_log where id=2"`, { stdio: "pipe" }); tamper = "deleted"; } catch (e) { tamper = e.stderr.toString(); }
  ok(/append-only/.test(tamper), "DELETE on audit_log refused");
  // a superuser can disable triggers; the chain check still catches it
  execSync(`psql -h localhost -p 5433 -U postgres dp2 -c "alter table audit_log disable trigger audit_log_ro_t; update audit_log set detail='{}' where id=3; alter table audit_log enable trigger audit_log_ro_t;"`, { stdio: "pipe" });
  chain = (await A("GET", "/api/admin/vault/audit/verify")).b; ok(!chain.ok && chain.first_broken == 3, `tampering by a DB superuser detected at entry #${chain.first_broken}`);
  const acts = psql(`select string_agg(distinct action, ', ' order by action) from audit_log`);
  console.log("     actions logged: " + acts);
  const ov = await A("GET", "/api/admin/vault/overview"); ok(ov.s === 200 && ov.b.corpora.length === 1, "admin overview works");
  ok((await j(W + "/api/admin/vault/overview")).s === 401, "vault admin API needs sign-in");
})().catch(e => { console.error(e); process.exit(1); });
