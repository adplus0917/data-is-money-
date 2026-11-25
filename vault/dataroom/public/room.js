/* Data room viewer. Pages arrive as images that already carry the watermark;
   this script draws them on a canvas, adds a second moving watermark, blocks
   copy / save / print / drag shortcuts, hides content when the window loses
   focus, and reports attempts to the server, which may cut the session.
   Honest limit: a phone camera or some operating-system capture tools cannot
   be detected by any web page. The burned-in watermark is what traces a leak. */
(() => {
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let me = null, cur = { i: 0, p: 1 }, ended = false, hb = null;

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  if (r.status === 401 && !url.endsWith("/login")) { showEnded(); throw new Error("ended"); }
  return r;
}

function loginView(msg) {
  $("app").innerHTML = `<form class="card" id="login"><h1>Data room</h1><p class="mute">Escribe el código de acceso que recibiste por separado.<br>Enter the access code you received separately.</p>
   <label for="code">Código / Code</label><input id="code" autocomplete="one-time-code" required maxlength="20">
   <p class="err">${esc(msg || "")}</p><button class="go" type="submit">Entrar / Enter</button></form>`;
}

function showEnded() {
  if (ended) return; ended = true; clearInterval(hb);
  $("out").classList.add("hide");
  $("app").innerHTML = `<div class="ended"><h1>Sesión terminada · Session ended</h1><p class="mute">La sesión se cerró. Si fue por una acción no permitida, el equipo de DATA Patrimonio ya fue notificado.<br>This session was closed. If it was caused by a blocked action, the DATA Patrimonio team has been notified.</p></div>`;
}

async function report(type) {
  if (ended || !me) return;
  try { const r = await api("POST", "/api/room/event", { type }); const j = await r.json(); if (j.cut) showEnded(); } catch (e) {}
}

function roomView() {
  $("out").classList.remove("hide");
  $("app").innerHTML = `<p class="mute">${esc(me.buyer)} · ${esc(me.name)} (${esc(me.email)}) · sesión ${esc(me.session)} · hasta / until ${esc(new Date(me.expires_at).toLocaleDateString())}</p>
   <div class="room"><ul class="files">${me.files.map(f => `<li><button type="button" data-i="${f.i}" aria-current="${f.i === cur.i}">${esc(f.name)}<br><small class="mute">${f.pages} p.</small></button></li>`).join("")}</ul>
   <div><div class="bar"><button type="button" id="prev">‹</button><span id="pg"></span><button type="button" id="next">›</button></div>
   <div class="viewer"><canvas id="cv" width="10" height="10"></canvas><div class="live" id="live"></div></div></div></div>`;
  load();
}

async function load() {
  const f = me.files[cur.i]; if (!f) return;
  $("pg").textContent = `${f.name} · ${cur.p} / ${f.pages}`;
  document.querySelectorAll(".files button").forEach(b => b.setAttribute("aria-current", +b.dataset.i === cur.i));
  try {
    const r = await api("GET", `/api/room/page/${cur.i}/${cur.p}`);
    if (!r.ok) { $("pg").textContent = "No se pudo mostrar / Could not render"; return; }
    const bmp = await createImageBitmap(await r.blob());      // never an <img> with a saveable URL
    const cv = $("cv"); cv.width = bmp.width; cv.height = bmp.height;
    cv.getContext("2d").drawImage(bmp, 0, 0); bmp.close();
  } catch (e) {}
}

/* moving second watermark */
setInterval(() => { if (me && $("live")) $("live").textContent = `${me.email} · ${me.session} · ${new Date().toLocaleTimeString()}`; }, 1000);

/* blocks + detection */
const block = e => { e.preventDefault(); return false; };
["contextmenu", "dragstart", "selectstart", "cut", "paste"].forEach(t => document.addEventListener(t, block));
document.addEventListener("copy", e => { e.preventDefault(); report("copy"); });
window.addEventListener("beforeprint", () => report("print"));
document.addEventListener("keydown", e => {
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (k === "printscreen") { block(e); report("printscreen"); }
  else if (mod && k === "s") { block(e); report("save"); }
  else if (mod && k === "p") { block(e); report("print"); }
  else if (mod && (k === "c" || k === "x")) { block(e); report("copy"); }
  else if (mod && k === "a") { block(e); report("select_all"); }
  else if (mod && k === "u") { block(e); report("view_source"); }
  else if (k === "f12" || (mod && e.shiftKey && ["i", "j", "c"].includes(k))) { block(e); report("devtools"); }
  else if (e.metaKey && e.shiftKey && ["3", "4", "5"].includes(k)) { report("printscreen"); }       // macOS capture keys (often not delivered)
});
document.addEventListener("keyup", e => { if (e.key === "PrintScreen") report("printscreen"); });

/* hide content whenever the window is not in front (capture tools usually take focus) */
const shield = on => $("shield").classList.toggle("hide", !on || !me || ended);
window.addEventListener("blur", () => { shield(true); report("window_blur"); });
window.addEventListener("focus", () => shield(false));
document.addEventListener("visibilitychange", () => { if (document.hidden) { shield(true); report("tab_hidden"); } });

/* devtools heuristic: docked inspector makes the window much bigger than the page */
setInterval(() => { if (me && !ended && (window.outerWidth - window.innerWidth > 200 || window.outerHeight - window.innerHeight > 260)) report("devtools"); }, 3000);

document.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b || !me) return;
  if (b.dataset.i) { cur = { i: +b.dataset.i, p: 1 }; load(); }
  if (b.id === "prev" && cur.p > 1) { cur.p--; load(); }
  if (b.id === "next" && cur.p < me.files[cur.i].pages) { cur.p++; load(); }
  if (b.id === "out") api("POST", "/api/room/logout").finally(showEnded);
});
document.addEventListener("submit", async e => {
  if (e.target.id !== "login") return; e.preventDefault();
  const invite = location.hash.slice(1);
  const r = await fetch("/api/room/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invite, code: $("code").value }) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); return loginView(j.error === "too many attempts" ? "Demasiados intentos / Too many attempts" : r.status === 423 ? "Bloqueado / Locked" : r.status === 403 ? "Este data room no está abierto / Not open" : "Enlace o código incorrecto / Wrong link or code"); }
  history.replaceState(null, "", "/r");                      // remove the invite token from the address bar
  start();
});

async function start() {
  const r = await fetch("/api/room/me", { credentials: "same-origin" });
  if (!r.ok) return loginView();
  me = await r.json(); ended = false;
  roomView();
  hb = setInterval(() => api("POST", "/api/room/heartbeat").catch(() => {}), 20000);
}
start();
})();
