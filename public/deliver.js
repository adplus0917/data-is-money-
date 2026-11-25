/* Full-corpus delivery page: /deliver#DP-2026-0001.<private token>
   The team creates this link from the team panel and sends it to the seller. */
(() => {
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const [folio, token] = location.hash.slice(1).split(".");
history.replaceState(null, "", "/deliver");          // keep the token out of the address bar
const items = [];
$("fol").textContent = folio ? "Folio " + folio : "";
if (!folio || !token) $("err").textContent = "Enlace incompleto. Pide un enlace nuevo. · Incomplete link: ask us for a new one.";

const draw = () => { $("list").innerHTML = items.map(i => `<li><span>${esc(i.name)}</span><span>${i.state === "ok" ? "✓ Recibido / Received" : i.state === "fail" ? esc(i.msg || "Error") : i.pct + "%"}</span></li>`).join(""); };

function put(url, headers, file, onPct) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(); x.open("PUT", url);
    Object.entries(headers || {}).forEach(([k, v]) => x.setRequestHeader(k, v));
    x.upload.onprogress = e => e.lengthComputable && onPct(Math.round(e.loaded / e.total * 100));
    x.onload = () => x.status < 300 ? resolve() : reject(new Error("upload failed (" + x.status + ")"));
    x.onerror = () => reject(new Error("network error"));
    x.send(file);
  });
}
async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Upload-Token": token }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 403 ? "Enlace vencido · Link expired" : j.error || "error");
  return j;
}
async function send(file) {
  const it = { name: file.name, pct: 0, state: "up" }; items.push(it); draw();
  try {
    const base = `/api/submissions/${encodeURIComponent(folio)}/uploads`;
    const { files: [slot] } = await post(base, { kind: "corpus", files: [{ name: file.name, size: file.size }] });
    if (!slot || slot.error) throw new Error(slot ? slot.error : "error");
    await put(slot.url, slot.headers, file, p => { it.pct = p; draw(); });
    await post(`${base}/${slot.id}/complete`, {});
    it.state = "ok";
  } catch (e) { it.state = "fail"; it.msg = e.message; }
  draw();
}
$("fileIn").addEventListener("change", async e => { for (const f of e.target.files) await send(f); });
document.addEventListener("dragover", e => { if (e.target.closest("#drop")) { e.preventDefault(); $("drop").classList.add("over"); } });
document.addEventListener("drop", async e => { if (e.target.closest("#drop")) { e.preventDefault(); $("drop").classList.remove("over"); for (const f of e.dataTransfer.files) await send(f); } });
})();
