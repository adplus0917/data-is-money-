// ============================================================
// Merge regression tests — the 4 mandatory fixes + engine integrity.
// Self-contained: starts the merged web server on :3200 with a throwaway
// JSON database (no vault configured), runs HTTP + unit checks, exits
// non-zero on any failure. Run:  node tests/merge/regression.js
// ============================================================
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "../..");
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) failures++; };

/* ---------- 1. Object Lock gate (config-level proof) ---------- */
{
  const setup = fs.readFileSync(path.join(ROOT, "ops/setup-buckets.js"), "utf8");
  ok(/VAULT_OBJECT_LOCK_MODE \|\| "off"/.test(setup) || /process\.env\.VAULT_OBJECT_LOCK_MODE \|\| "off"/.test(setup), "object lock defaults to off (VAULT_OBJECT_LOCK_MODE=off)");
  ok(!/\|\|\s*3650/.test(setup), "no 3650-day retention default remains in setup-buckets.js");
  ok(/ANDREW_DECISION_ON_FILE/.test(setup), "enabling any lock mode requires Andrew's confirmed decision");
  // no Allow of retention/bypass anywhere in the service policies
  let allowBad = false;
  for (const f of fs.readdirSync(path.join(ROOT, "ops/minio-policies")).filter(x => x.endsWith(".json"))) {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, "ops/minio-policies", f), "utf8"));
    for (const st of j.Statement || []) {
      const acts = [].concat(st.Action || []);
      if (st.Effect === "Allow" && acts.some(a => /Retention|BypassGovernance/.test(a))) allowBad = true;
    }
  }
  ok(!allowBad, "no MinIO policy grants PutObjectRetention/BypassGovernanceRetention");
  const envEx = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  ok(/VAULT_OBJECT_LOCK_MODE=off/.test(envEx), ".env.example ships VAULT_OBJECT_LOCK_MODE=off");
}

/* ---------- 2+4. Unit checks: email validation + auth cookie ---------- */
process.env.ADMIN_PASSWORD = "test-password-123";
process.env.SESSION_SECRET = "test-secret-for-regression";
const opt = require(path.join(ROOT, "server/options.js"));
const auth = require(path.join(ROOT, "server/auth.js"));
{
  ok(opt.emailError("ana@empresa.jet") === "tld", "emailError: ana@empresa.jet → 'tld'");
  ok(opt.emailError("ana@empresa.com") === null, "emailError: ana@empresa.com → valid");
  ok(opt.emailError("ana@empresa.co") === null, "emailError: country TLD .co → valid");
  ok(opt.emailError("ana@empresa.org") === null && opt.emailError("ana@empresa.net") === null, "emailError: .org/.net → valid");
  const base = { company_name: "Empresa SA", owner_name: "Ana Paz", signature_name: "Ana Paz" };
  const jet = opt.checkContact({ ...base, email: "ana@empresa.jet" });
  ok(!jet.ok && jet.error_code === "email_tld" && /not valid/.test(jet.error), "checkContact rejects .jet with the helpful message");
  ok(opt.checkContact({ ...base, email: "ana@empresa.com" }).ok === true, "checkContact accepts .com");

  // signature rules (server side of the signature window)
  const styled = opt.checkContact({ ...base, email: "ana@empresa.com", signature_method: "typed", signature_style: "dancing" });
  ok(styled.ok && styled.contact.signature_style === "dancing", "styled (typed) signature accepted and style saved");
  const mismatch = opt.checkContact({ ...base, email: "ana@empresa.com", signature_name: "Someone Else" });
  ok(!mismatch.ok && /must match/.test(mismatch.error), "typed signature not matching the representative is rejected");
  const png = "data:image/png;base64," + Buffer.alloc(300, 7).toString("base64");
  const drawn = opt.checkContact({ ...base, email: "ana@empresa.com", signature_method: "drawn", signature_data: png });
  ok(drawn.ok && drawn.contact.signature_data === png, "drawn signature accepted and PNG data saved");
  const drawnMissing = opt.checkContact({ ...base, email: "ana@empresa.com", signature_method: "drawn", signature_data: "" });
  ok(!drawnMissing.ok, "drawn signature with no drawing is rejected");

  // auth cookie: malformed → false (401 path), never a throw
  const fakeReq = cookie => ({ headers: cookie ? { cookie } : {} });
  let threw = false, res1, res2, res3;
  try {
    res1 = auth.isAdmin(fakeReq("dp_admin=9999999999999." + "z".repeat(64)));        // 64-char NON-hex signature (the crash case)
    res2 = auth.isAdmin(fakeReq("dp_admin=9999999999999." + "ab".repeat(10)));          // short signature
    res3 = auth.isAdmin(fakeReq("dp_admin=9999999999999." + "0".repeat(64)));           // valid shape, wrong signature
  } catch (e) { threw = true; }
  ok(!threw && res1 === false && res2 === false && res3 === false, "malformed/wrong admin cookies → not admin, no throw (no 500)");
  // a genuinely issued cookie still works
  let cookieVal = "";
  auth.issue({ setHeader: (k, v) => { cookieVal = v.split(";")[0]; } });
  ok(auth.isAdmin(fakeReq(cookieVal)) === true, "issued admin cookie still validates");
}

/* ---------- 3. Signature window present in the funnel ---------- */
{
  const app = fs.readFileSync(path.join(ROOT, "public/app.js"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "public/styles.css"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
  ok(/function sigModalHTML/.test(app) && /id="sigBox"/.test(app), "signature modal exists and the signature box opens it");
  ok(/id="sigCanvas"/.test(app), "modal includes a draw pad (canvas)");
  const styles = ["great", "dancing", "allura", "caveat", "sacramento", "kalam"];
  ok(styles.every(id => app.includes(`"${id}"`) && css.includes(`.sig-style-${id}`)), "all six signature styles present in the modal and the CSS");
  ok(/Great\+Vibes/.test(html) && /Dancing\+Script/.test(html), "signature fonts loaded by index.html");
  ok(/signature_done/.test(app) && /errSigMissing/.test(app), "no signature = no submit (client gate present)");
  ok(/focusout/.test(app) && /emailMsg/.test(app), "email error is shown inline on blur");
}

/* ---------- 5. Soft launch: nav windows, general feedback, live chat ---------- */
{
  const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
  const app = fs.readFileSync(path.join(ROOT, "public/app.js"), "utf8");
  const i18n = fs.readFileSync(path.join(ROOT, "public/i18n.js"), "utf8");
  const srv = fs.readFileSync(path.join(ROOT, "server/index.js"), "utf8");
  ok(/id="topnav"/.test(html) && /id="fbTop"/.test(html) && /id="chatRoot"/.test(html), "index.html: top nav, top comment button and chat mount present");
  ok(["inicio", "como", "valua", "seguridad", "preguntas", "contacto"].every(v => i18n.includes(v + ":")), "six nav windows defined (inicio/cómo/valúa/seguridad/preguntas/contacto)");
  ok(/data-nav/.test(app) && /S\.view = b\.dataset\.nav/.test(app), "nav tabs switch the visible view in app.js");
  ok(/data-view="seguridad"/.test(html) && /data-view="preguntas"/.test(html) && /data-view="contacto"/.test(html), "security, FAQ and contact sections exist as switchable views");
  ok(/wa\.me\/18136144279/.test(app), "chat/contact WhatsApp escape points at wa.me/18136144279");
  ok(app.includes("/api/chat") && app.includes("/api/contact") && app.includes('step: "general"'), "funnel calls /api/chat, /api/contact and general feedback");
  ok(/nav:\{inicio:/.test(i18n) && /nav:\{inicio:"Home"/.test(i18n), "nav labels exist in both languages");
  ok(/chatWa:"Continue on WhatsApp"/.test(i18n) && /chatWa:"Seguir por WhatsApp"/.test(i18n), "chat escape buttons labeled in both languages");
  ok(srv.includes('"/api/chat"') && srv.includes('"/api/contact"'), "server registers /api/chat and /api/contact");
  ok(srv.includes('step === "general"'), "server accepts step=general feedback");

  const { answerChat } = require(path.join(ROOT, "server/chat.js"));
  const buy = answerChat("¿Cómo funciona la compra directa?", "es");
  ok(buy.inScope && buy.topic === "compra_directa" && /Compra directa/.test(buy.text), "chat unit: ES direct-purchase question answered in scope");
  const lic = answerChat("How does the license work and when do I get paid?", "en");
  ok(lic.inScope && lic.topic === "licencia" && /65%/.test(lic.text), "chat unit: EN license question answered with the 65% term");
  const val = answerChat("How much is my data worth?", "en");
  ok(val.inScope && /preliminary estimate/i.test(val.text), "chat unit: valuation answer carries the preliminary-estimate disclaimer");
  const oos = answerChat("What's the weather in Tampa tomorrow?", "en");
  ok(!oos.inScope && oos.handoff && /WhatsApp/.test(oos.text), "chat unit: out-of-scope question hands off to WhatsApp/email, no invented answer");
  const oos2 = answerChat("¿Me garantizan que venderán mis datos por $500,000?", "es");
  ok(!/garantiz/.test(oos2.text) || oos2.topic === "licencia" || !oos2.inScope, "chat unit: no guaranteed-sale promise is ever made");
}

/* ---------- 6. Single deal path: exclusive direct purchase ONLY ----------
   (Nov 25 2026: Miguel first directed a two-button buy-vs-license choice,
   then reversed it minutes later — the funnel presents ONE path, a buy
   outright with exclusivity. We are always the buyer; no license option
   may be offered to the seller anywhere in the funnel.) ---------- */
{
  const app = fs.readFileSync(path.join(ROOT, "public/app.js"), "utf8");
  const i18n = fs.readFileSync(path.join(ROOT, "public/i18n.js"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "public/styles.css"), "utf8");
  ok(!/data-k="track"/.test(app) && /class="dealcard"/.test(app), "funnel step 3 shows ONE deal statement card — no track option buttons");
  ok(!/licNote/.test(app), "estimate step shows only the direct-purchase note (no license-note branch)");
  ok(/track: "compra_directa"/.test(app) && /S\.a\.track = "compra_directa"/.test(app), "funnel state pins the track to compra_directa (saved sessions normalized)");
  ok(/Compra directa con exclusividad/.test(i18n) && /Direct purchase with exclusivity/.test(i18n), "the single path is labeled 'Compra directa con exclusividad' / 'Direct purchase with exclusivity'");
  ok(/adquirimos los derechos en exclusiva/.test(i18n) && /acquire the rights exclusively/.test(i18n), "deal copy states WE acquire the rights exclusively (ES + EN)");
  const ag = i18n.slice(i18n.indexOf("const AG="));
  ok(!ag.includes('"licencia"'), "the agreement text (AG) contains no license track — purchase only");
  ok(/\.dealcard\{/.test(css), "dealcard statement styles present in styles.css");
  ok(opt.TRACKS.length === 1 && opt.TRACKS[0] === "compra_directa", "server accepts exactly ONE track value: compra_directa");
}

/* ---------- 7. Mobile / keyboard defects (Tyler acceptance, Nov 25 2026) ----------
   The Spanish valuation ran offscreen at mobile width; the chat widget
   covered the signature "Use" button and the funnel Continue button; and
   Tab escaped the open signature dialog to fields hidden behind it. */
{
  const app = fs.readFileSync(path.join(ROOT, "public/app.js"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "public/styles.css"), "utf8");
  ok(/class="amt"/.test(app) && /\.est \.num\{[^}]*flex-wrap:wrap/.test(css) && !/\.est \.num\{[^}]*white-space:nowrap/.test(css), "valuation range renders as wrap-safe amount spans \u2014 no nowrap overflow at mobile width");
  ok(/if \(S\.sigOpen \|\| S\.fbOpen\) return ""/.test(app), "chat widget is not rendered while a modal dialog is open (cannot cover its buttons)");
  ok(/\.sigmodal\{[^}]*z-index:90/.test(css), "modal layer (z-index 90) sits above the chat widget (z-index 70)");
  ok(/\.chatbtn \.chat-tx\{display:none\}/.test(css) && /\.wrap\{padding-bottom:110px\}/.test(css), "mobile chat collapses to a round bubble and the funnel gains bottom clearance");
  ok(/function focusIntoDialog/.test(app) && /addEventListener\("keydown"/.test(app) && /e\.key === "Escape"/.test(app) && /function restoreFocus/.test(app) && /function closeSig/.test(app), "modal focus management present: focus-in on open, Tab trap, Escape closes, focus restored to opener");
}

/* ---------- engine integrity + worked example ---------- */
{
  const { valueDataset } = require(path.join(ROOT, "server/engine.js"));
  const v = valueDataset({ revenueBand: "5to10m", recordYears: "5to10", employees: "1to10", dataTypes: ["invoices", "quotes", "contracts", "email"], format: "mixed", frequency: "static" });
  ok(v.point === 61667 && v.low === 46300 && v.high === 83300, `worked example reproduces $61,667 → $46,300–$83,300 (got ${v.point} → ${v.low}–${v.high})`);
}

/* ---------- HTTP checks against the running merged server ---------- */
const W = "http://localhost:3200";
const j = async (url, opt2 = {}) => { const r = await fetch(url, opt2); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; } return { s: r.status, b }; };
const answers = { sector: "roof", years_in_business: "over10", employees: "26to50", record_years: "5to10", data_types: ["invoices", "email", "accounting"], record_volume: "10kto50k", revenue_band: "5to10m", format: "digital_structured", frequency: "ongoing", track: "compra_directa" };
const MAN = [true, true, true, true, true];

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-merge-reg-"));
  const child = spawn(process.execPath, [path.join(ROOT, "server/index.js")], {
    env: { ...process.env, PORT: "3200", DATA_DIR: dataDir, DATABASE_URL: "", ADMIN_PASSWORD: "test-password-123", SESSION_SECRET: "test-secret-for-regression" },
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 50; i++) { try { const h = await j(W + "/health"); if (h.s === 200) break; } catch { await new Promise(r => setTimeout(r, 200)); } }

    const post = body => j(W + "/api/submissions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let r = await post({ answers, contact: { company_name: "X SA", owner_name: "Ana Paz", email: "ana@empresa.jet", signature_name: "Ana Paz" }, manifest: MAN });
    ok(r.s === 400 && /not a real domain/.test(r.b.error || ""), "HTTP: .jet submission rejected 400 with the helpful message (got " + r.s + ")");

    r = await post({ answers, contact: { company_name: "X SA", owner_name: "Ana Paz", email: "ana@empresa.com", signature_name: "Ana Paz" }, manifest: [true, true, true, false, true] });
    ok(r.s === 400, "HTTP: incomplete 5-item manifest still rejected (got " + r.s + ")");

    const png = "data:image/png;base64," + Buffer.alloc(300, 7).toString("base64");
    r = await post({ answers, contact: { company_name: "X SA", owner_name: "Ana Paz", email: "ana@empresa.com", signature_name: "Ana Paz", signature_method: "drawn", signature_data: png }, manifest: MAN });
    ok(r.s === 201 && !!r.b.folio, "HTTP: drawn-signature submission accepted (got " + r.s + ")");
    const dbJson = JSON.parse(fs.readFileSync(path.join(dataDir, "db.json"), "utf8"));
    const row = dbJson.submissions.find(x => x.folio === r.b.folio);
    ok(row && row.signature_method === "drawn" && row.signature_data === png, "drawn signature is saved on the submission");
    ok(row && row.track === "compra_directa", "submission records the single deal path: compra_directa (exclusive direct purchase)");

    r = await post({ answers: { ...answers, track: "licencia" }, contact: { company_name: "X SA", owner_name: "Ana Paz", email: "ana@empresa.com", signature_name: "Ana Paz" }, manifest: MAN });
    ok(r.s === 400, "HTTP: a license track is rejected — the funnel has ONE deal path (got " + r.s + ")");

    r = await post({ answers, contact: { company_name: "X SA", owner_name: "Ana Paz", email: "ana@empresa.com", signature_name: "Ana Paz", signature_method: "typed", signature_style: "allura" }, manifest: MAN });
    ok(r.s === 201, "HTTP: styled-signature submission accepted (got " + r.s + ")");
    const row2 = JSON.parse(fs.readFileSync(path.join(dataDir, "db.json"), "utf8")).submissions.find(x => x.folio === r.b.folio);
    ok(row2 && row2.signature_style === "allura", "signature style is saved on the submission");

    r = await j(W + "/api/admin/submissions", { headers: { Cookie: "dp_admin=9999999999999." + "z".repeat(64) } });
    ok(r.s === 401, "HTTP: crafted 64-char non-hex cookie → 401, not 500 (got " + r.s + ")");

    /* soft launch HTTP checks */
    const home = await (await fetch(W + "/")).text();
    ok(/id="topnav"/.test(home) && /data-view="seguridad"/.test(home) && /id="chatRoot"/.test(home), "HTTP: home page renders nav windows, security view and chat mount");

    r = await j(W + "/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: "general", comment: "El botón de valorar no se ve en mi teléfono", lang: "es" }) });
    ok(r.s === 201, "HTTP: top-of-page general feedback accepted (got " + r.s + ")");

    r = await j(W + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "¿Cómo funciona la compra directa?", lang: "es" }) });
    ok(r.s === 200 && r.b.inScope === true && r.b.topic === "compra_directa" && !!r.b.sessionId, "HTTP: chat answers an in-scope question and opens a session (got " + r.s + ")");
    const sid = r.b.sessionId;
    r = await j(W + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "What's the weather in Tampa tomorrow?", sessionId: sid, lang: "en" }) });
    ok(r.s === 200 && r.b.inScope === false && r.b.handoff === true && r.b.sessionId === sid, "HTTP: chat hands an out-of-scope question to WhatsApp/email in the same session");

    r = await j(W + "/api/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Ana", email: "ana@empresa.jet", message: "Hola" }) });
    ok(r.s === 400 && r.b.error_code === "email_tld", "HTTP: chat email form rejects a .jet address with the shared validator (got " + r.s + ")");
    r = await j(W + "/api/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Ana", email: "ana@empresa.com", message: "Quiero más información", track: "compra_directa" }) });
    ok(r.s === 201, "HTTP: chat email form accepts a valid address (got " + r.s + ")");
    r = await j(W + "/api/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Ana", email: "ana@empresa.com", message: "Hola", track: "licencia" }) });
    ok(r.s === 400, "HTTP: a gate lead carrying a license track is rejected (got " + r.s + ")");

    const login = await fetch(W + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test-password-123" }) });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    ok(login.status === 200 && cookie.includes("dp_admin="), "HTTP: admin login issues a session cookie");
    const A = u => j(W + u, { headers: { Cookie: cookie } });
    r = await A("/api/admin/feedback");
    ok(Array.isArray(r.b) && r.b.some(f => f.step === "general" && /botón de valorar/.test(f.comment)), "HTTP: general feedback appears in the admin panel");
    r = await A("/api/admin/chats");
    ok(Array.isArray(r.b) && r.b.length >= 1 && r.b[0].messages.length >= 2 && r.b[0].messages.some(m => m.role === "bot" && m.topic === "compra_directa"), "HTTP: chat transcript is logged and readable in the admin panel");
    r = await A("/api/admin/contact-messages");
    ok(Array.isArray(r.b) && r.b.some(m => m.email === "ana@empresa.com" && m.track === "compra_directa"), "HTTP: email-form message appears in the admin panel WITH its deal track");
    const csv = await (await fetch(W + "/api/admin/export.csv?table=contact", { headers: { Cookie: cookie } })).text();
    ok(/id,created_at,name,email,track,message/.test(csv) && csv.includes("compra_directa"), "HTTP: contact CSV export carries the track column and the single deal value");

    /* appointment booking (Nov 25 2026): funnel ends by booking the call */
    const days = opt.bookingDays();
    ok(days.length === 5 && days.every(d => d.weekday >= 1 && d.weekday <= 5), "booking: exactly 5 ET business days (Mon–Fri) are offered");
    r = await j(W + "/api/bookings/days");
    ok(r.s === 200 && Array.isArray(r.b.days) && r.b.days.length === 5 && r.b.tz === "America/New_York", "HTTP: offered-days endpoint matches the server validator");
    const bpost = body => j(W + "/api/bookings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    r = await bpost({ name: "Ana Paz", email: "ana@empresa.jet", date: days[0].date, window: "morning", answers });
    ok(r.s === 400 && r.b.error_code === "email_tld", "HTTP: booking rejects a .jet email with the shared validator (got " + r.s + ")");
    r = await bpost({ name: "Ana Paz", email: "ana@empresa.com", date: "2026-01-04", window: "morning", answers });
    ok(r.s === 400, "HTTP: booking rejects a day that is not in the offered list (got " + r.s + ")");
    r = await bpost({ name: "Ana Paz", email: "ana@empresa.com", date: days[0].date, window: "evening", answers });
    ok(r.s === 400, "HTTP: booking rejects an unknown time window (got " + r.s + ")");
    r = await bpost({ name: "Ana Paz", email: "ana@empresa.com", phone: "+1 813 555 0100", date: days[0].date, window: "afternoon", note: "Llamar después de las 2", answers, lang: "es" });
    ok(r.s === 201 && r.b.id && r.b.date === days[0].date && r.b.window === "afternoon", "HTTP: booking created with an offered day + window (got " + r.s + ")");
    const bkId = r.b.id;
    const bkRow = JSON.parse(fs.readFileSync(path.join(dataDir, "db.json"), "utf8")).bookings.find(x => x.id === bkId);
    ok(bkRow && bkRow.status === "pending" && bkRow.profile && bkRow.profile.sector === "roof" && bkRow.profile.estimate_low > 0 && bkRow.profile.track === "compra_directa", "booking is stored with the FULL screening profile + server-computed estimate");
    ok(bkRow && Array.isArray(bkRow.zoom_invitees) && bkRow.zoom_invitees.includes("gconcepcion@cpointehomes.com") && bkRow.zoom_invitees.includes("tkruse@cpointehomes.com") && bkRow.zoom_invitees.includes("migueladplus@gmail.com") && bkRow.zoom_status === "none", "booking carries the Zoom invitee list (Gil, Tyler, Miguel); no meeting exists yet");
    r = await post({ answers, contact: { company_name: "X SA", owner_name: "Ana Paz", email: "ana@empresa.com", signature_name: "Ana Paz" }, manifest: MAN, booking_id: bkId });
    ok(r.s === 201 && !!r.b.folio, "HTTP: submission after a booking is accepted (got " + r.s + ")");
    const bkLinked = JSON.parse(fs.readFileSync(path.join(dataDir, "db.json"), "utf8")).bookings.find(x => x.id === bkId);
    ok(bkLinked && bkLinked.folio === r.b.folio, "booking is linked to the signed submission's folio");
    r = await A("/api/admin/bookings");
    ok(Array.isArray(r.b) && r.b.some(x => x.id === bkId && x.profile && x.profile.estimate_high > 0), "HTTP: booking appears in the team panel WITH its company profile");
    r = await j(W + "/api/admin/bookings/" + bkId, { method: "PATCH", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ status: "confirmed" }) });
    ok(r.s === 200 && r.b.booking.status === "confirmed", "HTTP: panel moves a booking pending → confirmed");
    r = await j(W + "/api/admin/bookings/" + bkId + "/zoom", { method: "POST", headers: { Cookie: cookie } });
    ok(r.s === 200 && r.b.queued === true && r.b.configured === false && r.b.booking.zoom_status === "queued" && !r.b.booking.zoom_join_url, "HTTP: Create Zoom with no credentials QUEUES the intent and fakes NO meeting link");
    const zoomMod = require(path.join(ROOT, "server/zoom.js"));
    ok(zoomMod.configured() === false && zoomMod.meetingPayload({ name: "Ana", email: "ana@empresa.com", appt_date: days[0].date, window: "morning", profile: {} }).settings.auto_recording === "cloud", "zoom module: unconfigured in this env; the create payload always sets cloud auto-recording");
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL REGRESSION CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
