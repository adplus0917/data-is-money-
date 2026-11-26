/* ============================================================
   DATA Patrimonio — team panel (public/admin.html)
   Sign-in → submissions table with editable status, feedback inbox,
   pipeline explainer, engine settings + the kit's validation profiles,
   CSV/JSON export. Refreshes itself every 30 seconds.
   Server routes used: /api/admin/*  (all need the sign-in cookie)
   ============================================================ */
(() => {
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = n => "$" + Math.round(n).toLocaleString("en-US");
const kusd = n => n >= 1e6 ? "$" + (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : "$" + Math.round(n / 1000) + "K";
let lang = (() => { try { return localStorage.getItem("dp.lang") || "en" } catch (e) { return "en" } })();
const L = () => T[lang];
const lab = (list, code) => { const r = O[list].find(x => x[0] === code); return r ? (lang === "es" ? r[2] : r[1]) : (code || "—"); };

const VAL = [
  { label: "A · 3 lowest-weight types", inp: { employees: "1to10", revenueBand: "2to5m", recordYears: "3to5", dataTypes: ["invoices", "quotes", "contracts"], format: "mixed", frequency: "static" }, exp: [21000, 49000], on: "point" },
  { label: "A · 3 types incl. email + accounting", inp: { employees: "1to10", revenueBand: "2to5m", recordYears: "3to5", dataTypes: ["invoices", "email", "accounting"], format: "mixed", frequency: "static" }, exp: [21000, 49000], on: "point" },
  { label: "B · Miguel's case", inp: { employees: "1to10", revenueBand: "5to10m", recordYears: "5to10", dataTypes: ["invoices", "quotes", "contracts", "email"], format: "mixed", frequency: "static" }, exp: [47000, 89000], on: "near" },
  { label: "C", inp: { employees: "26to50", revenueBand: "5to10m", recordYears: "5to10", dataTypes: ["invoices", "quotes", "contracts", "email", "accounting"], format: "digital_structured", frequency: "static" }, exp: [74000, 172000], on: "point" },
  { label: "D", inp: { employees: "51to75", revenueBand: "over20m", recordYears: "over10", dataTypes: ["invoices", "quotes", "contracts", "drawings", "photos", "email", "accounting"], format: "digital_structured", frequency: "ongoing" }, exp: [275000, 450000], on: "point" },
];

/* ---------- API ---------- */
const API = {
  async call(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || "error"), { status: r.status });
    return j;
  },
  me() { return this.call("GET", "/api/admin/me"); },
  login(password) { return this.call("POST", "/api/admin/login", { password }); },
  logout() { return this.call("POST", "/api/admin/logout"); },
  submissions() { return this.call("GET", "/api/admin/submissions"); },
  feedback() { return this.call("GET", "/api/admin/feedback"); },
  chats() { return this.call("GET", "/api/admin/chats"); },
  contactMessages() { return this.call("GET", "/api/admin/contact-messages"); },
  bookings() { return this.call("GET", "/api/admin/bookings"); },
  setStatus(folio, status) { return this.call("PATCH", "/api/admin/submissions/" + encodeURIComponent(folio), { status }); },
  setBookingStatus(id, status) { return this.call("PATCH", "/api/admin/bookings/" + encodeURIComponent(id), { status }); },
  zoomBooking(id) { return this.call("POST", "/api/admin/bookings/" + encodeURIComponent(id) + "/zoom"); },
};

let signedIn = false, rows = [], frows = [], crows = [], mrows = [], brows = [], tab = "subs", timer = null, err = "", vaultOn = false;
fetch("/api/config").then(r => r.json()).then(j => { vaultOn = !!j.vault; if (signedIn) render(); }).catch(() => {});

async function load() {
  try { [rows, frows, crows, mrows, brows] = await Promise.all([API.submissions(), API.feedback(), API.chats(), API.contactMessages(), API.bookings()]); if (vaultOn && tab === "vault") await VAULT_TAB.load(); err = ""; }
  catch (e) { if (e.status === 401) { signedIn = false; clearInterval(timer); } else err = L().netErr; }
  render();
}

function loginHTML() {
  const l = L();
  return `<div class="card" style="max-width:440px;margin:40px auto"><h2>${l.loginT}</h2><p class="sub">${l.loginS}</p>
   <form id="login"><div class="f" style="margin-top:16px"><label for="pw">${l.pw}</label><input id="pw" type="password" autocomplete="current-password" required></div>
   <p class="err" id="err">${esc(err)}</p><div class="nav"><button class="btn go" type="submit">${l.signIn}</button></div></form></div>`;
}

function panelHTML() {
  const l = L();
  const dt = x => { const d = new Date(x); return isNaN(d) ? "—" : d.toLocaleString(lang === "es" ? "es-US" : "en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
  const pipe = rows.filter(r => r.status !== "Pagado").reduce((s, r) => s + (+r.estimate_high || 0), 0);
  const tbs = [["subs", l.tabSubs], ["fb", l.tabFb], ["chats", l.tabChats], ["contact", l.tabContact], ["bookings", l.tabBookings], ...(vaultOn ? [["vault", VAULT_TAB.label(lang)]] : []), ["how", l.tabHow], ["eng", l.tabEng]].map(([k, t]) => `<button type="button" class="pill" data-tab="${k}" aria-pressed="${tab === k}">${t}</button>`).join("");
  let body = "";
  if (tab === "subs") body = `<div class="nav" style="margin:0 0 14px"><a class="btn" href="/api/admin/export.csv">${l.exCsv}</a><a class="btn" href="/api/admin/export.csv?table=feedback">CSV · ${l.tabFb}</a><a class="btn" href="/api/admin/export.json">${l.exJson}</a></div>` +
    (rows.length ? `<div class="scroll"><table class="stack"><thead><tr>${l.cols.map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>
      <td style="white-space:nowrap"><b>${esc(r.folio)}</b></td><td>${dt(r.created_at)}</td><td>${esc(r.company_name)}<br><span class="sub">${esc(r.owner_name)}</span></td>
      <td>${esc(lab("sector", r.sector))}</td><td>${esc(lab("track", r.track))}</td><td class="n">${esc(usd(r.estimate_low) + " – " + usd(r.estimate_high))}</td><td>${esc(lab("tier", r.tier))}</td><td class="n">${esc(r.score)}</td>
      <td><select data-folio="${esc(r.folio)}" aria-label="Status ${esc(r.folio)}">${O.status.map(([s]) => `<option value="${esc(s)}" ${r.status === s ? "selected" : ""}>${esc(lab("status", s))}</option>`).join("")}</select></td>
      <td>${esc(r.email)}<br>${esc(r.phone)}</td>
      <td>${(r.samples || []).map(s => `<a href="/api/admin/samples/${encodeURIComponent(s.id)}">${esc(s.name)}</a>`).join("<br>")}</td></tr>`).join("")}</tbody></table></div>` : `<p class="sub">${l.empty}</p>`);
  if (tab === "fb") body = frows.length ? `<div class="scroll"><table class="stack"><thead><tr>${l.fcols.map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody>${frows.map(f => `<tr><td style="white-space:nowrap">${dt(f.created_at)}</td><td>${f.step === "general" ? l.generalWord : +f.step === 7 ? l.resultWord : l.stepWord + " " + esc(f.step)}</td><td>${esc(f.folio || "—")}</td><td>${esc(f.comment)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="sub">${l.fEmpty}</p>`;
  if (tab === "chats") body = crows.length ? `<div class="scroll"><table class="stack"><thead><tr>${l.chatCols.map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody>${crows.map(s => `<tr><td style="white-space:nowrap"><b>#${esc(s.id)}</b></td><td>${dt(s.created_at)}</td><td>${esc(s.lang || "—")}</td><td>${(s.messages || []).map(m => `<div style="margin:0 0 8px"><b>${m.role === "visitor" ? "🧑" : "🤖"} ${esc(m.role)}${m.topic ? " · " + esc(m.topic) : ""}:</b> ${esc(m.text)}</div>`).join("")}</td></tr>`).join("")}</tbody></table></div>` : `<p class="sub">${l.chatEmpty}</p>`;
  if (tab === "contact") body = mrows.length ? `<div class="scroll"><table class="stack"><thead><tr>${l.contactCols.map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody>${mrows.map(m => `<tr><td style="white-space:nowrap">${dt(m.created_at)}</td><td>${esc(m.name || "—")}</td><td>${esc(m.email)}</td><td>${esc(m.track ? lab("track", m.track) : "—")}</td><td>${esc(m.message)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="sub">${l.contactEmpty}</p>`;
  if (tab === "bookings") {
    const bkDay = (date) => new Date(String(date).slice(0, 10) + "T12:00:00Z").toLocaleDateString(lang === "es" ? "es-US" : "en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
    const zoomCell = bk => {
      const invitees = (bk.zoom_invitees && bk.zoom_invitees.length ? bk.zoom_invitees : ["gconcepcion@cpointehomes.com", "tkruse@cpointehomes.com", "migueladplus@gmail.com"]).join(", ");
      if (bk.zoom_status === "created" && bk.zoom_join_url) return `<a href="${esc(bk.zoom_join_url)}" target="_blank" rel="noopener">Zoom ✓</a><br><span class="sub">${esc(invitees)}</span>`;
      return `<button type="button" class="pill" data-bkzoom="${esc(bk.id)}">${l.bkZoomBtn}</button><br><span class="sub">${esc(lab("bkzoom", bk.zoom_status || "none"))} · ${esc(l.bkZoomFor)}</span>${bk.zoom_note ? `<br><span class="sub">${esc(bk.zoom_note)}</span>` : ""}`;
    };
    body = brows.length ? `<div class="scroll"><table class="stack"><thead><tr>${l.bkCols.map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody>${brows.map(bk => { const p = bk.profile || {}; return `<tr>
      <td style="white-space:nowrap">${dt(bk.created_at)}</td>
      <td style="white-space:nowrap"><b>${esc(bkDay(bk.appt_date))}</b><br>${esc(bk.window === "morning" ? l.bkMorning : l.bkAfternoon)} ${esc(bk.window === "morning" ? l.bkMorningH : l.bkAfternoonH)}</td>
      <td>${esc(bk.name)}${bk.folio ? `<br><span class="sub">${esc(bk.folio)}</span>` : ""}</td>
      <td>${esc(bk.email)}</td><td>${esc(bk.phone || "—")}</td>
      <td>${esc(lab("sector", p.sector))} · ${esc(lab("emp", p.employees))} · ${esc(lab("years", p.record_years))} · ${esc(lab("rev", p.revenue_band))}<br><span class="sub">${esc(lab("track", p.track || "compra_directa"))}</span></td>
      <td class="n">${p.estimate_low != null ? esc(usd(p.estimate_low) + " – " + usd(p.estimate_high)) : "—"}</td>
      <td><select data-bkstatus="${esc(bk.id)}" aria-label="Booking status">${O.bkstatus.map(([s]) => `<option value="${esc(s)}" ${bk.status === s ? "selected" : ""}>${esc(lab("bkstatus", s))}</option>`).join("")}</select></td>
      <td>${zoomCell(bk)}</td>
      <td>${esc(bk.note || "—")}</td></tr>`; }).join("")}</tbody></table></div>` : `<p class="sub">${l.bkEmpty}</p>`;
  }
  if (tab === "vault") body = VAULT_TAB.render(lang);
  if (tab === "how") body = `<h3 style="font-size:20px">${l.pipeT}</h3><div class="hg">${l.pipe.map((h, n) => `<div><i>${n + 1}</i><h3>${h[0]}</h3><p>${h[1]}</p></div>`).join("")}</div>`;
  if (tab === "eng") {
    const g = (name, obj, list, money) => `<tr><th colspan="2">${name}</th></tr>` + Object.entries(obj).map(([k, v]) => `<tr><td>${esc(lab(list, k))}</td><td class="n">${money ? usd(v) : "× " + v.toFixed(2)}</td></tr>`).join("");
    const vr = VAL.map(p => {
      const v = valueDataset(p.inp);
      const ok = p.on === "near" ? (v.low >= p.exp[0] * 0.95 && v.high <= p.exp[1] * 1.05) : (v.point >= p.exp[0] && v.point <= p.exp[1]);
      const inp = `${lab("emp", p.inp.employees)} · ${lab("rev", p.inp.revenueBand)} · ${lab("years", p.inp.recordYears)} · ${p.inp.dataTypes.map(t => lab("types", t)).join(", ")} · ${lab("fmt", p.inp.format)} · ${lab("freq", p.inp.frequency)}`;
      return `<tr><td><b>${esc(p.label)}</b></td><td>${esc(inp)}</td><td class="n">${usd(v.point)}</td><td class="n">${usd(v.low)} – ${usd(v.high)}</td><td>${esc(lab("tier", v.tier))}</td><td class="n">${v.score}</td><td class="n">${kusd(p.exp[0])} – ${kusd(p.exp[1])}</td><td class="${ok ? "pass" : "miss"}">${ok ? l.pass : l.miss}</td></tr>`;
    }).join("");
    body = `<h3 style="font-size:20px">${l.valT}</h3><div class="scroll"><table class="stack"><thead><tr>${l.vcols.map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody>${vr}</tbody></table></div><p class="note">${l.valNote}</p>
     <h3 style="font-size:20px;margin-top:28px">${l.engT}</h3><div class="scroll" style="max-width:560px"><table><tbody>${g(l.fl.base, CONFIG.revenueBase, "rev", true)}${g(l.fl.fYears, CONFIG.recordYearsFactor, "years")}${g(l.fl.fEmployees, CONFIG.employeesFactor, "emp")}${g(l.fl.fFormat, CONFIG.formatFactor, "fmt")}${g(l.fl.fFrequency, CONFIG.frequencyFactor, "freq")}
     <tr><th colspan="2">${l.fl.fTypes}</th></tr>${Object.entries(CONFIG.dataTypeWeight).map(([k, w]) => `<tr><td>${esc(lab("types", k))}</td><td class="n">${w} pt</td></tr>`).join("")}<tr><td>0.75 + (pts ÷ 9) × 0.50, max 1.25</td><td></td></tr>
     <tr><th colspan="2">${l.tierL}</th></tr>${CONFIG.tiers.map(t => `<tr><td>${esc(lab("tier", t.name))}</td><td class="n">${t.max === Infinity ? "> $200,000" : "≤ " + usd(t.max)}</td></tr>`).join("")}</tbody></table></div>`;
  }
  return `<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><div><h2>${l.adT}</h2><p class="sub">${l.adSub}</p></div>
    <div style="margin-left:auto;display:flex;gap:8px"><a class="pill" href="/">${l.backFunnel}</a><button class="pill" type="button" id="logout">${l.logout}</button></div></div>
   ${err ? `<p class="err">${esc(err)}</p>` : ""}
   <div class="kpis"><div><b>${rows.length}</b><span>${l.k1}</span></div><div><b>${kusd(pipe)}</b><span>${l.k2}</span></div><div><b>${rows.filter(r => r.status === "Nuevo" || r.status === "Muestra recibida").length}</b><span>${l.k3}</span></div><div><b>${frows.length}</b><span>${l.k4}</span></div><div><b>${brows.length}</b><span>${l.k5}</span></div></div>
   <div class="tabs" role="group">${tbs}</div>${body}`;
}

function render() {
  const l = L();
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-lang]").forEach(b => b.setAttribute("aria-pressed", b.dataset.lang === lang));
  $("tag").textContent = l.tag; $("foot").textContent = l.foot;
  $("adminView").innerHTML = signedIn ? panelHTML() : loginHTML();
}

/* stacked table labels on phones */
new MutationObserver(() => { for (const c of document.querySelectorAll(".stack td:not([data-l])")) { let i = 0, p = c; while ((p = p.previousElementSibling)) i += p.colSpan; c.dataset.l = c.closest("table").rows[0].cells[i]?.textContent || ""; } }).observe(document.body, { childList: true, subtree: true });

document.addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.lang) { lang = b.dataset.lang; try { localStorage.setItem("dp.lang", lang) } catch (x) {} render(); return; }
  if (b.dataset.tab) { tab = b.dataset.tab; render(); if (tab === "vault") { await VAULT_TAB.load(); render(); } return; }
  if (b.dataset.bkzoom) { b.disabled = true; try { await API.zoomBooking(b.dataset.bkzoom); await load(); } catch (x) { err = L().netErr; render(); } return; }
  if (tab === "vault" && await VAULT_TAB.handle(e, lang)) { render(); return; }
  if (b.id === "logout") { await API.logout().catch(() => {}); signedIn = false; clearInterval(timer); render(); }
});
document.addEventListener("submit", async e => {
  if (tab === "vault" && e.target.id !== "login") { e.preventDefault(); if (await VAULT_TAB.handle(e, lang)) render(); return; }
  if (e.target.id !== "login") return;
  e.preventDefault();
  try { await API.login($("pw").value); signedIn = true; err = ""; await load(); timer = setInterval(load, 30000); }
  catch (x) { err = x.status === 401 || x.status === 429 ? L().badPw : x.message; render(); }
});
document.addEventListener("change", async e => {
  const s = e.target;
  if (s.dataset.bkstatus && s.tagName === "SELECT") {
    s.disabled = true;
    try { await API.setBookingStatus(s.dataset.bkstatus, s.value); const r = brows.find(x => String(x.id) === String(s.dataset.bkstatus)); if (r) r.status = s.value; }
    catch (x) { err = L().netErr; }
    s.disabled = false; render(); return;
  }
  if (!s.dataset.folio || s.tagName !== "SELECT") return;
  s.disabled = true;
  try { await API.setStatus(s.dataset.folio, s.value); const r = rows.find(x => x.folio === s.dataset.folio); if (r) r.status = s.value; }
  catch (x) { err = L().netErr; }
  s.disabled = false; render();
});

(async () => {
  try { signedIn = (await API.me()).signedIn; } catch (e) { signedIn = false; }
  render();
  if (signedIn) { await load(); timer = setInterval(load, 30000); }
})();
})();
