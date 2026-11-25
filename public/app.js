/* ============================================================
   DATA Patrimonio — seller funnel (runs in the seller's browser)
   Needs: /engine.js (valueDataset) and /i18n.js (O, T, AG) loaded first.
   Talks to the server through the API object only:
     POST /api/submissions            step 5 → folio + private upload token
     POST /api/submissions/:folio/samples   step 6 sample files
     POST /api/feedback               the feedback box on every step
   ============================================================ */
(() => {
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = n => "$" + Math.round(n).toLocaleString("en-US");
const kusd = n => n >= 1e6 ? "$" + (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : "$" + Math.round(n / 1000) + "K";
const SS = { get(k, d) { try { return JSON.parse(sessionStorage.getItem(k)) ?? d } catch (e) { return d } }, set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)) } catch (e) {} } };
const LS = { get(k, d) { try { return localStorage.getItem(k) ?? d } catch (e) { return d } }, set(k, v) { try { localStorage.setItem(k, v) } catch (e) {} } };

/* ---------- state: one seller session (kept in this tab only) ---------- */
const blank = () => ({ sector: "", years_in_business: "", employees: "", record_years: "", data_types: [], record_volume: "", revenue_band: "", format: "", frequency: "", track: "", company_name: "", owner_name: "", email: "", phone: "", man: [], signature_name: "", signature_method: "typed", signature_style: "great", signature_data: "", signature_done: false });

/* ---------- email validation (merge fix, ported from the live site) ----------
   Format AND a real top-level domain: ".jet" is not a real TLD and is
   rejected; 2-letter endings are country codes and pass. The server runs
   the identical check (server/options.js emailError). */
const KNOWN_TLDS_CLIENT = new Set("com net org edu gov mil int info biz name pro aero coop museum mobi travel jobs asia tel post xxx cat geo academy agency app art audio auto autos baby band bar bargains baseball basketball beauty beer best bid bike bingo bio black blog blue boo book boutique builders business buzz cab cafe camera camp capital cards care career careers cars casa cash casino catering center ceo chat cheap church city claims cleaning clinic clothing cloud club coach codes coffee college community company computer condos construction consulting contact contractors cooking cool country coupons courses credit cricket cruises dance date dating deals degree delivery democrat dental dentist design dev diamonds diet digital direct directory discount doctor dog domains download earth education email energy engineer engineering enterprises equipment estate events exchange expert exposed express fail faith family fans farm fashion feedback finance financial fish fishing fit fitness flights florist flowers fly football forsale forum foundation fun fund furniture futbol fyi gallery game games garden gay gifts gives glass global gmbh gold golf graphics gratis green gripe group guide guitars guru hair haus health healthcare help hiphop hockey holdings holiday homes horse hospital host hosting house how icu immo immobilien inc industries ink institute insure international investments jewelry kitchen land lawyer lease legal lgbt life lighting limited limo live living llc loan loans lol love ltd luxe luxury maison management market marketing markets mba media memorial men menu moda moe mom money mortgage motorcycles movie nagoya navy network news ninja now observer okinawa one online organic page partners parts party pet pharmacy photo photography photos physio pics pictures pink pizza place plumbing plus poker porn press productions promo properties property protection pub qpon quebec racing radio realty recipes red rehab reisen rentals repair report republican restaurant restaurants review reviews rip rocks rodeo rugby run sale salon sarl school schule science security select services sex sexy shoes shopping show singles site ski soccer social software solar solutions soy space storage store stream studio study style sucks supplies supply support surf surgery systems tattoo tax taxi team tech technology tennis theater theatre tickets tienda tips tires today tokyo tools top tours town toys trade training tube university uno vacations vegas ventures vet video villas vin vip vision vodka vote voting voto voyage watch webcam website wedding wiki win wine work works world wow xyz yoga yokohama zone lat rio usa".split(" "));
function emailErrorClient(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || e.length > 254 || /\s/.test(e)) return "format";
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.exec(e)) return "format";
  const [local, domain] = e.split("@");
  if (!local || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return "format";
  if (!domain || domain.includes("..")) return "format";
  const labels = domain.split(".");
  if (labels.some(l => !l || l.startsWith("-") || l.endsWith("-"))) return "format";
  const tld = labels[labels.length - 1] || "";
  if (tld.length === 2) return null;
  if (!KNOWN_TLDS_CLIENT.has(tld)) return "tld";
  return null;
}
const emailMsg = l => { const a = S.a; if (!a.email.trim()) return ""; const err = emailErrorClient(a.email); return err === "tld" ? l.errEmailTld : err === "format" ? l.errEmailFmt : ""; };

/* ---------- signature window (merge fix, ported from the live site) ---------- */
const SIG_STYLES = [["great", "sig-style-great"], ["dancing", "sig-style-dancing"], ["allura", "sig-style-allura"], ["caveat", "sig-style-caveat"], ["sacramento", "sig-style-sacramento"], ["kalam", "sig-style-kalam"]];
const sigClass = id => (SIG_STYLES.find(x => x[0] === id) || SIG_STYLES[0])[1];
let S = Object.assign({ step: 0, a: blank(), folio: null, token: null, samples: [] }, SS.get("dp.session", {}));
S.lang = LS.get("dp.lang", (navigator.language || "").startsWith("es") ? "es" : "en");
/* soft launch additions: top-nav view, general-feedback modal, live chat */
S.view = S.view || "inicio";
S.fbOpen = false;
S.contact = S.contact || { name: "", email: "", message: "", sent: false, err: "" };
S.chat = S.chat || { open: false, sessionId: null, msgs: [], emailOpen: false, email: "", emailMsg: "", emailSent: false, emailErr: "", busy: false };
/* price gate (Nov 25 2026): the step-4 estimate stays hidden until the
   visitor leaves name + email; the lead is saved via /api/contact into
   the existing contact_messages capture (team panel → Messages). */
S.gate = S.gate || { name: "", email: "", phone: "", done: false, err: "", busy: false };
const save = () => SS.set("dp.session", S);
const L = () => T[S.lang];
const lab = (list, code) => { const r = O[list].find(x => x[0] === code); return r ? (S.lang === "es" ? r[2] : r[1]) : (code || "—"); };
const engineInput = a => ({ revenueBand: a.revenue_band, recordYears: a.record_years, employees: a.employees, dataTypes: a.data_types, format: a.format, frequency: a.frequency });

/* ---------- API: every call to the server goes through here ---------- */
const API = {
  async post(url, body, headers = {}) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || "error"), { status: r.status });
    return j;
  },
  submit(a, lang) {
    const answers = { sector: a.sector, years_in_business: a.years_in_business, employees: a.employees, record_years: a.record_years, data_types: a.data_types, record_volume: a.record_volume, revenue_band: a.revenue_band, format: a.format, frequency: a.frequency, track: a.track };
    const contact = { company_name: a.company_name, owner_name: a.owner_name, email: a.email, phone: a.phone, signature_name: a.signature_name, signature_method: a.signature_method, signature_style: a.signature_style, signature_data: a.signature_method === "drawn" ? a.signature_data : "" };
    return this.post("/api/submissions", { answers, contact, manifest: L().man.map((_, i) => a.man.includes(i)), lang });
  },
  async upload(folio, token, file) {
    const fd = new FormData(); fd.append("files", file);
    const r = await fetch(`/api/submissions/${encodeURIComponent(folio)}/samples`, { method: "POST", headers: { "X-Upload-Token": token }, body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || "error"), { status: r.status });
    return j;
  },
  // direct-to-staging upload for big files: ask for a signed URL, PUT the file, confirm
  async direct(folio, token, file, kind) {
    const h = { "X-Upload-Token": token };
    const { files: [slot] } = await this.post(`/api/submissions/${encodeURIComponent(folio)}/uploads`, { kind, files: [{ name: file.name, size: file.size }] }, h);
    if (!slot || slot.error) throw new Error(slot ? slot.error : "error");
    const put = await fetch(slot.url, { method: "PUT", headers: slot.headers, body: file });
    if (!put.ok) throw new Error("upload failed");
    await this.post(`/api/submissions/${encodeURIComponent(folio)}/uploads/${slot.id}/complete`, {}, h);
  },
  feedback(step, comment) { return this.post("/api/feedback", { step, comment, folio: S.folio, lang: S.lang }); },
  feedbackGeneral(comment) { return this.post("/api/feedback", { step: "general", comment, folio: S.folio, lang: S.lang }); },
  chat(message) { return this.post("/api/chat", { message, sessionId: S.chat.sessionId, lang: S.lang }); },
  contact(name, email, message) { return this.post("/api/contact", { name, email, message, lang: S.lang }); },
};

/* ---------- screens ---------- */
const opts = (list, key, filter) => `<div class="opts">${O[list].filter(r => !filter || r[3] === filter).map(([c]) => `<button type="button" class="opt" data-k="${key}" data-v="${c}" aria-pressed="${S.a[key] === c}">${esc(lab(list, c))}</button>`).join("")}</div>`;
const fbBox = step => `<div class="fb"><b>${L().fbT}</b><form data-fb="${step}"><textarea maxlength="500" aria-label="${L().fbT}" placeholder="${L().fbPh}"></textarea><button class="btn" type="submit">${L().fbSend}</button></form><div class="ok hide" role="status">${L().fbOk}</div></div>`;
const navBtns = (i, label) => `<p class="err" id="err"></p><div class="nav">${i ? `<button type="button" class="btn" id="back">${L().back}</button>` : ""}<button type="button" class="btn go" id="next">${label}</button></div>`;

function stepHTML() {
  const l = L(), i = S.step, a = S.a, h = `<div class="kick">${l.stepOf(i + 1)}</div><h2>${l.steps[i]}</h2><p class="sub">${l.subs[i]}</p>`;
  if (i === 0) return h + `<span class="q">${l.qSector}</span><div class="grp">${l.gT}</div>${opts("sector", "sector", "t")}<div class="grp">${l.gO}</div>${opts("sector", "sector", "o")}<span class="q">${l.qBiz}</span>${opts("years", "years_in_business")}<span class="q">${l.qEmp}</span>${opts("emp", "employees")}` + navBtns(i, l.next) + fbBox(1);
  if (i === 1) return h + `<span class="q">${l.qRec}</span>${opts("years", "record_years")}<span class="q">${l.qTypes}</span><div class="opts">${O.types.map(([c]) => `<button type="button" class="opt" data-type="${c}" aria-pressed="${a.data_types.includes(c)}">${esc(lab("types", c))}</button>`).join("")}</div><span class="q">${l.qVol}</span>${opts("vol", "record_volume")}` + navBtns(i, l.next) + fbBox(2);
  if (i === 2) return h + `<span class="q">${l.qRev}</span>${opts("rev", "revenue_band")}<span class="q">${l.qFmt}</span>${opts("fmt", "format")}<span class="q">${l.qFreq}</span><div class="opts wide">${O.freq.map(([c]) => `<button type="button" class="opt" data-k="frequency" data-v="${c}" aria-pressed="${a.frequency === c}">${esc(lab("freq", c))}</button>`).join("")}</div><span class="q">${l.qTrack}</span><div class="opts wide">${O.track.map(([c]) => `<button type="button" class="opt" data-k="track" data-v="${c}" aria-pressed="${a.track === c}">${esc(lab("track", c))}<small>${l.trackD[c]}</small></button>`).join("")}</div>` + navBtns(i, l.see) + fbBox(3);
  if (i === 3 && !S.gate.done) return gateHTML();
  if (i === 3) {
    const v = valueDataset(engineInput(a)), b = v.breakdown;
    const sub = { base: lab("rev", a.revenue_band), fYears: lab("years", a.record_years), fEmployees: lab("emp", a.employees), fTypes: l.typesN(a.data_types.length), fFormat: lab("fmt", a.format), fFrequency: lab("freq", a.frequency) };
    return h + `<div class="est"><div class="lbl">${l.rangeL}</div><div class="num">${usd(v.low)} – ${usd(v.high)}</div><div class="tier">${l.tierL}: ${esc(lab("tier", v.tier))}</div>
     <div class="score"><span>${l.scoreL}</span><div class="m"><i style="width:${v.score}%"></i></div><b>${v.score}/100</b></div></div>
     <h3 style="font-size:18px;margin-top:22px">${l.built}</h3><div class="factors">${Object.keys(b).map(k => `<div><span>${l.fl[k]}<small>${esc(sub[k])}</small></span><b>${k === "base" ? usd(b[k]) : "× " + b[k].toFixed(2)}</b></div>`).join("")}<div class="tot"><span>${l.pointL}</span><b>${usd(v.point)}</b></div></div>
     <p class="disc">${l.disc}</p><p class="trackn">${a.track === "licencia" ? l.licNote : l.buyNote}</p>` + navBtns(i, l.toContract) + fbBox(4);
  }
  if (i === 4) {
    const today = new Date().toLocaleDateString(S.lang === "es" ? "es-US" : "en-US", { year: "numeric", month: "long", day: "numeric" });
    const f = (k, lb, type, ac) => `<div class="f"><label for="f_${k}">${lb}</label><input id="f_${k}" data-f="${k}" type="${type}" autocomplete="${ac}" maxlength="160" value="${esc(a[k])}">${k === "email" ? `<div class="emsg" id="emailMsg" role="alert">${esc(emailMsg(l))}</div>` : ""}</div>`;
    return h + `<p class="intro">${l.intro}</p><div class="fields">${f("company_name", l.fCo, "text", "organization")}${f("owner_name", l.fOwner, "text", "name")}${f("email", l.fEmail, "email", "email")}${f("phone", l.fPhone, "tel", "tel")}</div>
     <h3 style="font-size:18px;margin-top:24px">${l.agT} <span class="draft">${S.lang === "es" ? "BORRADOR" : "DRAFT"}</span></h3><div class="agree" tabindex="0">${AG[S.lang].map(([tr, t, p]) => `<div class="${tr && tr === a.track ? "hl" : ""}"><h3>${t}</h3><p>${p}</p></div>`).join("")}</div>
     <h3 style="font-size:18px;margin-top:24px">${l.manT}</h3><div style="margin-top:8px">${l.man.map((m, n) => `<label class="ck"><input type="checkbox" data-man="${n}" ${a.man.includes(n) ? "checked" : ""}><span>${m}</span></label>`).join("")}</div>
     <div class="fields"><div class="f"><label>${l.sigL}</label><button type="button" class="sigbox" id="sigBox" aria-haspopup="dialog">${a.signature_done ? (a.signature_method === "drawn" && a.signature_data ? `<img src="${a.signature_data}" alt="${esc(a.signature_name)}"><span class="chosen">${l.sigChosen}</span>` : `<span class="sigpreview ${sigClass(a.signature_style)}">${esc(a.signature_name)}</span><span class="chosen">${l.sigChosen}</span>`) : `<b>✍ ${l.sigClick}</b><span>${l.sigHint}</span>`}</button></div><div class="f"><label for="f_date">${l.dateL}</label><input id="f_date" value="${today}" readonly></div></div>` + navBtns(i, l.submit) + fbBox(5) + (S.sigOpen ? sigModalHTML() : "");
  }
  const first = (a.owner_name || "").trim().split(/\s+/)[0] || "";
  const st = s => s.state === "ok" ? l.upOk : s.state === "fail" ? (s.msg || l.upFail) : "…";
  return `<div class="kick">${l.stepOf(6)}</div><h2>${esc(l.doneH(first, S.folio))}</h2><p class="sub">${l.subs[5]}</p><div class="folio num">${esc(S.folio)}</div>
   <p>${l.doneP}</p>
   <h3 style="font-size:18px;margin-top:20px">${l.upT}</h3><label class="drop" id="drop"><input type="file" id="fileIn" multiple><b>${l.drop}</b><br><span class="sub">${l.dropS}</span></label>
   <ul class="files">${S.samples.map(s => `<li><span>${esc(s.name)}</span><span>${(s.size / 1048576).toFixed(1)} MB · ${esc(st(s))}</span></li>`).join("")}</ul>
   <div class="nav"><button type="button" class="btn" id="again">${l.again}</button></div>` + fbBox(6);
}

/* Price gate: shown in place of the step-4 estimate until the visitor's
   name + email are saved. The lead goes through the EXISTING /api/contact
   capture (contact_messages, team panel → Messages) with the funnel
   answers attached — no parallel store, no new table. */
function gateHTML() {
  const l = L(), g = S.gate;
  const emErr = g.email.trim() ? emailErrorClient(g.email) : null;
  const em = emErr === "tld" ? l.errEmailTld : emErr === "format" ? l.errEmailFmt : "";
  return `<div class="kick">${l.stepOf(4)}</div><h2>${l.gateT}</h2><p class="sub">${l.gateS}</p>
   <div class="fields">
    <div class="f"><label for="g_name">${l.gateName}</label><input id="g_name" data-g="name" type="text" autocomplete="name" maxlength="160" value="${esc(g.name)}"></div>
    <div class="f"><label for="g_email">${l.fEmail}</label><input id="g_email" data-g="email" type="email" autocomplete="email" maxlength="200" value="${esc(g.email)}"><div class="emsg" role="alert">${esc(em)}</div></div>
    <div class="f"><label for="g_phone">${l.gateWa}</label><input id="g_phone" data-g="phone" type="tel" autocomplete="tel" maxlength="40" value="${esc(g.phone)}"></div>
   </div>
   <p class="disc">${l.gateNote}</p>
   <p class="err" id="err">${esc(g.err)}</p><div class="nav"><button type="button" class="btn" id="back">${l.back}</button><button type="button" class="btn go" id="gateGo" ${g.busy ? "disabled" : ""}>${l.gateBtn}</button></div>` + fbBox(4);
}

async function gateSubmit() {
  const l = L(), g = S.gate, a = S.a;
  if (g.busy) return;
  if (!g.name.trim()) { g.err = l.gateErrName; save(); render(); return; }
  const emErr = emailErrorClient(g.email);
  if (emErr) { g.err = emErr === "tld" ? l.errEmailTld : l.errEmailFmt; save(); render(); return; }
  g.busy = true; g.err = ""; save(); render();
  const lines = [l.gateLead,
    `${l.gateName}: ${g.name.trim()}`,
    `${l.fEmail}: ${g.email.trim()}`,
    g.phone.trim() ? `${l.gateWa}: ${g.phone.trim()}` : null,
    `${l.qSector}: ${lab("sector", a.sector)}`,
    `${l.qRec}: ${lab("years", a.record_years)}`,
    `${l.qEmp}: ${lab("emp", a.employees)}`,
    `${l.qTypes}: ${a.data_types.map(t => lab("types", t)).join(", ")}`,
    `${l.qRev}: ${lab("rev", a.revenue_band)}`,
    `${l.qTrack}: ${lab("track", a.track)}`].filter(Boolean).join("\n");
  try {
    await API.contact(g.name.trim(), g.email.trim(), lines);
    g.done = true; g.busy = false;
    if (!a.owner_name) a.owner_name = g.name.trim();
    if (!a.email) a.email = g.email.trim();
    if (!a.phone && g.phone.trim()) a.phone = g.phone.trim();
    save(); render(); $("start").scrollIntoView({ block: "start" });
  } catch (e) {
    g.busy = false;
    g.err = e.status === 400 && e.message && e.message !== "error" ? e.message : l.netErr;
    save(); render();
  }
}

function sigModalHTML() {
  const l = L(), a = S.a, tab = S.sigTab || a.signature_method || "typed";
  const name = a.signature_name || a.owner_name || "";
  const typed = `<label for="sigName" style="font-weight:600;font-size:14px">${l.sigPrompt}</label>
    <input id="sigName" value="${esc(name)}" placeholder="${esc(l.sigPh)}" maxlength="120" autocomplete="name" style="width:100%;min-height:48px;font-size:16px;padding:10px 12px;border:1.5px solid var(--line);border-radius:10px;background:var(--field);margin-top:6px">
    <div role="radiogroup" aria-label="${l.sigStyles}">${SIG_STYLES.map(([id, cls]) => `<button type="button" class="sigopt" data-sigstyle="${id}" role="radio" aria-checked="${(S.sigStyle || a.signature_style) === id}"><span class="nm ${cls}">${esc(name.trim() || l.sigPh)}</span></button>`).join("")}</div>`;
  const drawn = `<p style="font-weight:600;font-size:14px;margin:0 0 6px">${l.sigDrawPrompt}</p>
    <canvas id="sigCanvas" width="520" height="180" aria-label="${esc(l.sigDrawPrompt)}"></canvas>
    <div><button type="button" class="btn" id="sigClear" style="margin-top:8px">${l.sigClear}</button></div>
    <label for="sigNameDraw" style="font-weight:600;font-size:14px;display:block;margin-top:12px">${l.sigPrompt}</label>
    <input id="sigNameDraw" value="${esc(name)}" placeholder="${esc(l.sigPh)}" maxlength="120" autocomplete="name" style="width:100%;min-height:48px;font-size:16px;padding:10px 12px;border:1.5px solid var(--line);border-radius:10px;background:var(--field);margin-top:6px">`;
  return `<div class="sigmodal" id="sigModal"><div class="sigsheet" role="dialog" aria-modal="true" aria-label="${esc(l.sigModalT)}">
    <h3 style="font-size:20px">${l.sigModalT}</h3>
    <div class="sigtabs" role="group"><button type="button" id="sigTabType" aria-pressed="${tab === "typed"}">${l.sigTabType}</button><button type="button" id="sigTabDraw" aria-pressed="${tab === "drawn"}">${l.sigTabDraw}</button></div>
    ${tab === "drawn" ? drawn : typed}
    <p class="sigerr" id="sigErr" role="alert"></p>
    <div class="nav"><button type="button" class="btn" id="sigCancel">${l.sigCancel}</button><button type="button" class="btn go" id="sigUse">${l.sigUse}</button></div></div></div>`;
}

function valid() {
  const a = S.a, l = L();
  if (S.step === 0 && !(a.sector && a.years_in_business && a.employees)) return l.e1;
  if (S.step === 1 && !(a.record_years && a.data_types.length && a.record_volume)) return l.e2;
  if (S.step === 2 && !(a.revenue_band && a.format && a.frequency && a.track)) return l.e3;
  if (S.step === 4) {
    if (!(a.company_name.trim() && a.owner_name.trim() && (a.email.trim() || a.phone.trim()) && a.man.length === l.man.length)) return l.e5;
    if (a.email.trim()) { const em = emailMsg(l); if (em) return em; }
    if (!a.signature_done) return l.errSigMissing;
    if (a.signature_method === "drawn" && !a.signature_data) return l.errSigMissing;
    if (a.signature_method !== "drawn" && a.signature_name.trim().toLowerCase() !== a.owner_name.trim().toLowerCase()) return l.errSigMatch;
  }
  return "";
}

function marketHTML() {
  const l = L(), mx = 450000;
  return `<h2>${l.mkT}</h2><p class="sub">${l.mkS}</p><div class="mk"><div>
   <h3 style="font-size:20px">${l.dealsT}</h3>${l.deals.map(([n, v]) => `<div class="deal"><span>${n}</span><div class="track"><i style="width:${(v / mx * 100).toFixed(1)}%"></i></div><b>${kusd(v)}</b></div>`).join("")}<p class="tag">${l.dealsTag}</p>
   <h3 style="font-size:20px;margin-top:26px">${l.bandsT}</h3><table class="mtab"><tbody>${l.bands.map(([n, a, b]) => `<tr><td>${n}</td><td class="n">${kusd(a)} – ${kusd(b)}</td></tr>`).join("")}</tbody></table><p class="tag">${l.bandsTag}</p></div>
   <div><h3 style="font-size:20px">${l.advT}</h3><ul class="mlist">${l.adv.map(x => `<li>${x}</li>`).join("")}</ul>
   <div class="cant"><h3>${l.cantT}</h3><p>${l.cantP}</p></div></div></div>`;
}

/* ---------- soft launch: nav windows, security/FAQ/contact, chat, feedback ---------- */
const waLink = l => "https://wa.me/18136144279?text=" + encodeURIComponent(l.conWaMsg);
function securityHTML() {
  const l = L();
  return `<h2>${l.secT}</h2><p class="sub">${l.secS}</p><div class="hg">${l.sec.map(([t, p]) => `<div><h3 style="font-size:17px">${t}</h3><p>${p}</p></div>`).join("")}</div>`;
}
function faqHTML() {
  const l = L();
  return `<h2>${l.faqT}</h2><div style="margin-top:18px">${l.faq.map(([q, a]) => `<div class="faqitem"><h3 style="font-size:17px">${q}</h3><p>${a}</p></div>`).join("")}</div>`;
}
function contactHTML() {
  const l = L(), c = S.contact;
  return `<h2>${l.conT}</h2><p class="sub">${l.conS}</p>
   <div class="cta" style="margin-top:16px"><a class="btn go" style="margin:0" target="_blank" rel="noopener" href="${waLink(l)}">${l.conWa}</a><span class="trust">${l.chatNote}</span></div>
   <h3 style="font-size:18px;margin-top:26px">${l.conFormT}</h3>
   ${c.sent ? `<p class="okmsg" role="status">${l.conOk}</p>` : `<form data-contact novalidate>
     <div class="fields"><div class="f"><label for="cf_name">${l.fName}</label><input id="cf_name" data-cf="name" value="${esc(c.name)}" maxlength="160" autocomplete="name"></div>
     <div class="f"><label for="cf_email">${l.fEmail}</label><input id="cf_email" data-cf="email" type="email" value="${esc(c.email)}" maxlength="200" autocomplete="email"><div class="emsg" role="alert">${esc(c.err)}</div></div></div>
     <div class="f" style="margin-top:14px"><label for="cf_msg">${l.fMsg}</label><textarea id="cf_msg" data-cf="message" maxlength="2000" style="width:100%;min-height:96px;font-size:16px;padding:10px 12px;border:1.5px solid var(--line);border-radius:10px;background:var(--field)">${esc(c.message)}</textarea></div>
     <div class="nav"><button class="btn go" type="submit">${l.conSend}</button></div></form>`}`;
}
function fbModalHTML() {
  const l = L();
  return `<div class="sigmodal"><div class="sigsheet" role="dialog" aria-modal="true" aria-label="${esc(l.fbModalT)}">
    <h3 style="font-size:20px">${l.fbModalT}</h3><p class="sub" style="margin-top:8px">${l.fbModalS}</p>
    <form data-fbg><textarea id="fbGeneral" maxlength="500" aria-label="${esc(l.fbModalT)}" placeholder="${esc(l.fbPh)}" style="width:100%;min-height:110px;font-size:16px;padding:10px 12px;border:1.5px solid var(--line);border-radius:10px;background:var(--field);margin-top:10px"></textarea>
    <div class="okmsg hide" id="fbGenOk" role="status">${l.fbOk}</div>
    <div class="nav"><button type="button" class="btn" id="fbClose">${l.sigCancel}</button><button class="btn go" type="submit">${l.fbSend}</button></div></form></div></div>`;
}
function chatHTML() {
  const l = L(), c = S.chat;
  if (!c.open) return `<button type="button" class="chatbtn" id="chatOpen">💬 ${l.chatOpen}</button>`;
  const msgs = c.msgs.map(m => `<div class="chatmsg ${m.role === "visitor" ? "me" : "bot"}">${esc(m.text)}</div>`).join("");
  const emailForm = c.emailOpen ? (c.emailSent ? `<p class="okmsg" role="status">${l.chatSent}</p>` : `<form data-chatemail class="chatemail" novalidate>
      <p style="margin:0 0 8px;font-size:14px">${l.chatEmailT}</p>
      <input type="email" id="chatEmailIn" placeholder="${esc(l.fEmail)}" value="${esc(c.email)}" maxlength="200" autocomplete="email">
      <div class="emsg" role="alert">${esc(c.emailErr)}</div>
      <textarea id="chatEmailMsg" placeholder="${esc(l.fMsg)}" maxlength="2000">${esc(c.emailMsg)}</textarea>
      <button class="btn go" type="submit" style="min-height:44px;width:100%">${l.chatEmail}</button></form>`) : "";
  return `<div class="chatpanel" role="dialog" aria-label="${esc(l.chatT)}">
    <div class="chathead"><b>${l.chatT}</b><button type="button" class="chatx" id="chatClose" aria-label="Close">✕</button></div>
    <div class="chatmsgs" id="chatMsgs">${msgs}</div>
    <form data-chat class="chatform"><input id="chatIn" placeholder="${esc(l.chatPh)}" maxlength="1000" autocomplete="off" ${c.busy ? "disabled" : ""}><button class="btn go" type="submit" style="min-height:48px" ${c.busy ? "disabled" : ""}>${l.chatSend}</button></form>
    <div class="chatactions"><a class="btn" target="_blank" rel="noopener" href="${waLink(l)}">${l.chatWa}</a><button type="button" class="btn" id="chatEmailToggle">${l.chatEmail}</button></div>
    ${emailForm}</div>`;
}

function render() {
  const l = L();
  document.documentElement.lang = S.lang;
  document.querySelectorAll("[data-lang]").forEach(b => b.setAttribute("aria-pressed", b.dataset.lang === S.lang));
  $("tag").textContent = l.tag; $("heroT").textContent = l.heroT; $("heroP").textContent = l.heroP; $("ctaBtn").textContent = l.cta; $("trust").textContent = l.trust; $("foot").textContent = l.foot;
  const hChip = $("heroChip"); if (hChip) hChip.textContent = l.heroChip;
  const sLbl = $("sound-label"), sAu = $("ambient-audio"); if (sLbl) sLbl.textContent = (sAu && !sAu.paused) ? l.soundOn : l.soundOff;
  $("fbTop").textContent = "💬 " + l.fbNav;
  $("topnav").innerHTML = Object.entries(l.nav).map(([k, t]) => `<button type="button" class="navtab" data-nav="${k}" aria-pressed="${S.view === k}">${t}</button>`).join("");
  document.querySelectorAll("[data-view]").forEach(el => el.classList.toggle("hide", !el.dataset.view.split(" ").includes(S.view)));
  $("how").innerHTML = `<h2>${l.howT}</h2><div class="hg">${l.how.map((h, n) => `<div><i>${n + 1}</i><h3 style="font-size:17px">${h}</h3></div>`).join("")}</div>`;
  $("market").innerHTML = marketHTML();
  $("seguridad").innerHTML = securityHTML();
  $("faq").innerHTML = faqHTML();
  $("contacto").innerHTML = contactHTML();
  $("chatRoot").innerHTML = chatHTML();
  $("fbRoot").innerHTML = S.fbOpen ? fbModalHTML() : "";
  const cm = $("chatMsgs"); if (cm) cm.scrollTop = cm.scrollHeight;
  $("bar").innerHTML = l.steps.map((_, n) => `<i class="${n <= S.step ? "lit" : ""}"></i>`).join("");
  $("stepnames").innerHTML = l.steps.map((s, n) => `<span class="${n === S.step ? "cur" : ""}">${s}</span>`).join("");
  $("panel").innerHTML = stepHTML();
  const cv = $("sigCanvas");
  if (cv && S.a.signature_method === "drawn" && S.a.signature_data) { const img = new Image(); img.onload = () => cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height); img.src = S.a.signature_data; }
  save();
}

/* ---------- auto-advance (Nov 25 2026, Miguel's direction) ----------
   Picking answers moves the funnel forward on its own: the next
   unanswered question scrolls into view, and once a step's answers are
   complete the funnel advances by itself — no hunting for Continue.
   Manual navigation stays for the typed/review steps (gate, contract).
   Auto-advance can never skip the price gate: advancing from the last
   question step lands on the valuation step, which renders the gate
   form instead of the estimate until the lead is saved. */
let advTimer = null;
function stopAdv() { if (advTimer) { clearTimeout(advTimer); advTimer = null; } }
function scrollNextQuestion() {
  const panel = $("panel"); if (!panel) return;
  const groups = [], seenKeys = new Set();
  panel.querySelectorAll(".opts").forEach(gEl => {
    const opt = gEl.querySelector("[data-k],[data-type]");
    if (!opt) return;
    const key = opt.dataset.k || "data_types";
    if (seenKeys.has(key)) return;
    seenKeys.add(key); groups.push({ key, el: gEl });
  });
  for (const { key, el } of groups) {
    const answered = key === "data_types"
      ? !!panel.querySelector('[data-type][aria-pressed="true"]')
      : !!panel.querySelector('[data-k="' + key + '"][aria-pressed="true"]');
    if (!answered) {
      const prev = el.previousElementSibling;
      (prev && (prev.classList.contains("q") || prev.classList.contains("grp")) ? prev : el).scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
  }
}
function afterPick() {
  stopAdv();
  if (![0, 1, 2].includes(S.step)) return;
  if (valid()) { scrollNextQuestion(); return; }
  advTimer = setTimeout(() => {
    advTimer = null;
    if (![0, 1, 2].includes(S.step) || valid()) return;
    S.step++; save(); render(); $("start").scrollIntoView({ block: "start", behavior: "smooth" });
  }, 550);
}

/* ---------- actions ---------- */
async function submit(btn) {
  btn.disabled = true;
  try {
    const r = await API.submit(S.a, S.lang);
    S.folio = r.folio; S.token = r.uploadToken; S.step = 5; S.samples = [];
    render(); $("start").scrollIntoView({ block: "start" });
  } catch (e) {
    btn.disabled = false;
    $("err").textContent = e.status === 400 && e.message && e.message !== "error" ? e.message : (e.status ? L().eSave : L().netErr);
  }
}

// Small files go through the server (scanned there); large files go straight to the
// encrypted staging bucket with a one-hour signed link (scanned by the vault's ingest job).
let CFG = { vault: false, maxSampleMb: 20, maxDirectGb: 5 };
fetch("/api/config").then(r => r.json()).then(j => { CFG = j; }).catch(() => {});

async function addFiles(list) {
  for (const f of [...list].slice(0, 10 - S.samples.length)) {
    const rec = { name: f.name, size: f.size, state: "up" }; S.samples.push(rec); render();
    try {
      if (f.size <= CFG.maxSampleMb * 1048576) await API.upload(S.folio, S.token, f);
      else if (CFG.vault) await API.direct(S.folio, S.token, f, "sample");
      else throw new Error(`max ${CFG.maxSampleMb} MB`);
      rec.state = "ok";
    } catch (e) { rec.state = "fail"; rec.msg = e.status === 403 ? L().upToken : e.message; }
    render();
  }
}

/* signature canvas: pointer drawing (mouse or finger) */
let sigDraw = null;
document.addEventListener("pointerdown", e => {
  if (e.target.id !== "sigCanvas") return;
  const cv = e.target, r = cv.getBoundingClientRect();
  sigDraw = { cv, x: (e.clientX - r.left) / r.width * cv.width, y: (e.clientY - r.top) / r.height * cv.height };
  cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
  e.preventDefault();
});
document.addEventListener("pointermove", e => {
  if (!sigDraw) return;
  const { cv } = sigDraw, r = cv.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width * cv.width, y = (e.clientY - r.top) / r.height * cv.height;
  const ctx = cv.getContext("2d");
  ctx.strokeStyle = "#10203c"; ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath(); ctx.moveTo(sigDraw.x, sigDraw.y); ctx.lineTo(x, y); ctx.stroke();
  sigDraw.x = x; sigDraw.y = y; S.sigDrawn = true;
});
document.addEventListener("pointerup", () => { sigDraw = null; });
document.addEventListener("focusout", e => {
  if (e.target.id === "f_email") { const m = $("emailMsg"); if (m) m.textContent = emailMsg(L()); }
});

document.addEventListener("click", e => {
  if (e.target.closest("#ctaBtn")) { e.preventDefault(); S.view = "valua"; save(); render(); $("start").scrollIntoView({ block: "start", behavior: "smooth" }); return; }
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.nav) { S.view = b.dataset.nav; save(); render(); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
  if (b.id === "fbTop") { S.fbOpen = true; render(); const t = $("fbGeneral"); if (t) t.focus(); return; }
  if (b.id === "fbClose") { S.fbOpen = false; render(); return; }
  if (b.id === "chatOpen") { S.chat.open = true; if (!S.chat.msgs.length) S.chat.msgs.push({ role: "bot", text: L().chatHello }); save(); render(); const i = $("chatIn"); if (i) i.focus(); return; }
  if (b.id === "chatClose") { S.chat.open = false; save(); render(); return; }
  if (b.id === "chatEmailToggle") { S.chat.emailOpen = !S.chat.emailOpen; render(); return; }
  if (b.id === "sigBox") { S.sigOpen = true; S.sigTab = S.a.signature_method || "typed"; S.sigStyle = S.a.signature_style || "great"; S.sigDrawn = !!S.a.signature_data; render(); return; }
  if (b.id === "sigCancel") { S.sigOpen = false; render(); return; }
  if (b.id === "sigTabType" || b.id === "sigTabDraw") { const ne = $("sigName") || $("sigNameDraw"); if (ne && ne.value.trim()) S.a.signature_name = ne.value; S.sigTab = b.id === "sigTabDraw" ? "drawn" : "typed"; render(); return; }
  if (b.dataset.sigstyle) { const ne = $("sigName"); if (ne) S.a.signature_name = ne.value; S.sigStyle = b.dataset.sigstyle; render(); return; }
  if (b.id === "sigClear") { const cv = $("sigCanvas"); if (cv) cv.getContext("2d").clearRect(0, 0, cv.width, cv.height); S.sigDrawn = false; return; }
  if (b.id === "sigUse") {
    const l = L(), err = $("sigErr"), tab = S.sigTab || "typed";
    const nameEl = $(tab === "drawn" ? "sigNameDraw" : "sigName");
    const name = (nameEl ? nameEl.value : "").trim();
    if (tab === "drawn") {
      if (!S.sigDrawn) { err.textContent = l.sigDrawEmpty; return; }
      const cv = $("sigCanvas");
      S.a.signature_data = cv.toDataURL("image/png");
      S.a.signature_method = "drawn";
      S.a.signature_name = name || S.a.owner_name;
    } else {
      if (name.toLowerCase() !== S.a.owner_name.trim().toLowerCase()) { err.textContent = l.errSigMatch; return; }
      S.a.signature_name = name;
      S.a.signature_method = "typed";
      S.a.signature_style = S.sigStyle || "great";
      S.a.signature_data = "";
    }
    S.a.signature_done = true; S.sigOpen = false; save(); render(); return;
  }
  if (b.dataset.lang) { S.lang = b.dataset.lang; LS.set("dp.lang", S.lang); render(); return; }
  if (b.dataset.k) { S.a[b.dataset.k] = b.dataset.v; render(); afterPick(); return; }
  if (b.dataset.type) { const k = b.dataset.type; S.a.data_types = S.a.data_types.includes(k) ? S.a.data_types.filter(x => x !== k) : [...S.a.data_types, k]; render(); afterPick(); return; }
  if (b.id === "gateGo") { stopAdv(); gateSubmit(); return; }
  if (b.id === "back") { stopAdv(); S.step--; render(); return; }
  if (b.id === "next") {
    stopAdv();
    const m = valid(); if (m) { $("err").textContent = m; return; }
    if (S.step === 4) { submit(b); return; }
    S.step++; render(); $("start").scrollIntoView({ block: "start", behavior: "smooth" }); return;
  }
  if (b.id === "again") { stopAdv(); const keep = { lang: S.lang, view: S.view, chat: S.chat, contact: S.contact, gate: S.gate }; S = { step: 0, a: blank(), folio: null, token: null, samples: [], fbOpen: false, ...keep }; render(); $("start").scrollIntoView({ block: "start" }); }
});
document.addEventListener("input", e => {
  const el = e.target;
  if (el.dataset.f) { S.a[el.dataset.f] = el.value; save(); }
  if (el.dataset.g) { S.gate[el.dataset.g] = el.value; save(); }
  if (el.dataset.cf) { S.contact[el.dataset.cf] = el.value; save(); }
  if (el.id === "chatEmailIn") { S.chat.email = el.value; save(); }
  if (el.id === "chatEmailMsg") { S.chat.emailMsg = el.value; save(); }
  if (el.dataset.man !== undefined) { const n = +el.dataset.man; S.a.man = el.checked ? [...new Set([...S.a.man, n])] : S.a.man.filter(x => x !== n); save(); }
});
document.addEventListener("change", e => { if (e.target.id === "fileIn") addFiles(e.target.files); });
const emailErrText = v => { const err = emailErrorClient(v); return err === "tld" ? L().errEmailTld : err === "format" ? L().errEmailFmt : ""; };
document.addEventListener("submit", async e => {
  const fbg = e.target.closest("form[data-fbg]");
  if (fbg) {
    e.preventDefault();
    const ta = fbg.querySelector("textarea"), comment = ta.value.trim(); if (!comment) return;
    const ok = $("fbGenOk");
    try { await API.feedbackGeneral(comment); ta.value = ""; ok.textContent = L().fbOk; }
    catch (err) { ok.textContent = L().netErr; }
    ok.classList.remove("hide");
    return;
  }
  const fc = e.target.closest("form[data-chat]");
  if (fc) {
    e.preventDefault();
    const inp = $("chatIn"), msg = (inp.value || "").trim(); if (!msg || S.chat.busy) return;
    S.chat.msgs.push({ role: "visitor", text: msg }); S.chat.busy = true; render();
    try {
      const r = await API.chat(msg);
      S.chat.sessionId = r.sessionId;
      S.chat.msgs.push({ role: "bot", text: r.reply });
    } catch (err) { S.chat.msgs.push({ role: "bot", text: L().netErr }); }
    S.chat.busy = false; save(); render();
    const i2 = $("chatIn"); if (i2) i2.focus();
    return;
  }
  const fce = e.target.closest("form[data-chatemail]");
  if (fce) {
    e.preventDefault();
    const em = ($("chatEmailIn").value || "").trim(), ms = ($("chatEmailMsg").value || "").trim();
    const emErr = emailErrText(em);
    if (emErr) { S.chat.emailErr = emErr; render(); return; }
    if (!ms) { S.chat.emailErr = L().fMsg; render(); return; }
    try { await API.contact("", em, ms); S.chat.emailSent = true; S.chat.emailErr = ""; }
    catch (err) { S.chat.emailErr = err.status === 400 && err.message && err.message !== "error" ? err.message : L().netErr; }
    save(); render();
    return;
  }
  const fct = e.target.closest("form[data-contact]");
  if (fct) {
    e.preventDefault();
    const c = S.contact, emErr = emailErrText(c.email.trim());
    if (emErr) { c.err = emErr; render(); return; }
    if (!c.message.trim()) { c.err = L().fMsg; render(); return; }
    try { await API.contact(c.name, c.email, c.message); c.sent = true; c.err = ""; }
    catch (err) { c.err = err.status === 400 && err.message && err.message !== "error" ? err.message : L().netErr; }
    save(); render();
    return;
  }
  const f = e.target.closest("form[data-fb]"); if (!f) return;
  e.preventDefault();
  const ta = f.querySelector("textarea"), comment = ta.value.trim(); if (!comment) return;
  const ok = f.nextElementSibling;
  try { await API.feedback(+f.dataset.fb, comment); ta.value = ""; ok.textContent = L().fbOk; }
  catch (err) { ok.textContent = L().netErr; }
  ok.classList.remove("hide");
});
document.addEventListener("dragover", e => { const d = e.target.closest("#drop"); if (d) { e.preventDefault(); d.classList.add("over"); } });
document.addEventListener("dragleave", e => { const d = e.target.closest("#drop"); if (d) d.classList.remove("over"); });
document.addEventListener("drop", e => { const d = e.target.closest("#drop"); if (d) { e.preventDefault(); addFiles(e.dataTransfer.files); } });

render();
})();
