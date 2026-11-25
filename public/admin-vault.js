/* ============================================================
   Team panel · "Vault" tab (shown only when the vault is configured)
   Corpora + verification gate · engagements (viewing copies) and invites ·
   data-room sessions with a cut button · the append-only audit log.
   No file contents ever reach this page: only names, sizes, hashes and stats.
   ============================================================ */
window.VAULT_TAB = (() => {
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mb = n => n == null ? "—" : n >= 1073741824 ? (n / 1073741824).toFixed(2) + " GB" : (n / 1048576).toFixed(1) + " MB";
const V = {
  en: { tab: "Vault", corp: "Corpora (master copies)", verify: "Verify", reject: "Reject", files: "Files", status: "Status", size: "Size", scan: "Scan", hash: "SHA-256", prof: "Stats (no contents)",
    gate: "A corpus stays LOCKED until you verify it. Nothing can be viewed before that.", eng: "Engagements (viewing copies)", newEng: "New engagement", buyer: "Buyer / lab", folios: "Folios (comma-separated)",
    kind: "Type", buyerK: "Buyer", internalK: "Internal review", red: "Redaction", pii: "Remove personal data (PII)", none: "None (as-is)", cols: "Also redact columns (optional, comma-separated)", ends: "Ends on", create: "Create and build",
    invite: "Invite viewer", name: "Name", email: "Email", send: "Create invite", rebuild: "Rebuild", revoke: "Revoke", withheld: "withheld", viewers: "Viewers",
    once: "Copy these now; they are shown only once. Send the link and the code by two different channels (e.g. email + text).", link: "Link", code: "Code",
    sess: "Data-room sessions", cut: "Cut", open: "open", aud: "Audit log", verifyChain: "Check log integrity", chainOk: n => `Intact: ${n} entries, no edits or deletions.`, chainBad: id => `BROKEN at entry #${id}. Investigate immediately.`,
    filter: "Filter", folio: "Folio", action: "Action", dl: "Delivery link for folio", mk: "Create link", jobs: "Jobs", none2: "Nothing yet.", confirmRevoke: "Revoke this data room now? Its viewing copy will be deleted." },
  es: { tab: "Bóveda", corp: "Corpus (copias maestras)", verify: "Verificar", reject: "Rechazar", files: "Archivos", status: "Estado", size: "Tamaño", scan: "Escaneo", hash: "SHA-256", prof: "Estadísticas (sin contenido)",
    gate: "Un corpus queda BLOQUEADO hasta que lo verificas. Nada se puede ver antes.", eng: "Accesos (copias de visualización)", newEng: "Nuevo acceso", buyer: "Comprador / lab", folios: "Folios (separados por coma)",
    kind: "Tipo", buyerK: "Comprador", internalK: "Revisión interna", red: "Redacción", pii: "Quitar datos personales", none: "Ninguna (tal cual)", cols: "Además tachar columnas (opcional, separadas por coma)", ends: "Termina el", create: "Crear y construir",
    invite: "Invitar visor", name: "Nombre", email: "Correo", send: "Crear invitación", rebuild: "Reconstruir", revoke: "Revocar", withheld: "retenidos", viewers: "Visores",
    once: "Cópialos ahora; solo se muestran una vez. Envía el enlace y el código por dos canales distintos (p. ej. correo + mensaje).", link: "Enlace", code: "Código",
    sess: "Sesiones del data room", cut: "Cortar", open: "abierta", aud: "Registro de auditoría", verifyChain: "Comprobar integridad", chainOk: n => `Íntegro: ${n} entradas, sin ediciones ni borrados.`, chainBad: id => `ROTO en la entrada #${id}. Investigar de inmediato.`,
    filter: "Filtrar", folio: "Folio", action: "Acción", dl: "Enlace de entrega para el folio", mk: "Crear enlace", jobs: "Trabajos", none2: "Nada todavía.", confirmRevoke: "¿Revocar este data room ahora? Se borrará su copia de visualización." },
};
let data = null, auditRows = [], chain = null, secret = null, deliver = null, filters = { folio: "", action: "" }, inviteFor = null, err = "";
const call = async (method, url, body) => {
  const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "error");
  return j;
};

async function load() {
  try {
    const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
    [data, auditRows] = await Promise.all([call("GET", "/api/admin/vault/overview"), call("GET", "/api/admin/vault/audit?" + q)]);
    err = "";
  } catch (e) { err = e.message; }
}

function render(lang) {
  const t = V[lang] || V.en;
  if (!data) return `<p class="sub">…</p>${err ? `<p class="err">${esc(err)}</p>` : ""}`;
  const dt = x => x ? new Date(x).toLocaleString(lang === "es" ? "es-US" : "en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
  const filesOf = f => data.files.filter(x => x.folio === f);
  const prof = p => !p ? "" : [p.type, p.lines != null ? p.lines + " lines" : "", p.pages_estimate ? "~" + p.pages_estimate + " pages" : "", p.columns ? p.columns.length + " cols: " + p.columns.slice(0, 6).join(", ") : "", p.sheets ? p.sheets.map(s => `${s.name} (${s.rows})`).join(", ") : ""].filter(Boolean).join(" · ");
  const jobs = (data.jobs || []).map(j => `${j.status}: ${j.n}`).join(" · ");

  const corp = data.corpora.length ? data.corpora.map(c => `<details class="card" style="max-width:none;margin:0 0 10px;padding:14px">
    <summary style="cursor:pointer;display:flex;gap:12px;flex-wrap:wrap;align-items:center"><b>${esc(c.folio)}</b><span>${esc(c.company_name)}</span><span class="tier" style="margin:0">${esc(c.status)}</span><span class="sub">${c.file_count} · ${mb(+c.total_bytes)}</span>
     <span style="margin-left:auto;display:flex;gap:8px">${c.status !== "verified" ? `<button class="btn" type="button" data-v-verify="${esc(c.folio)}">${t.verify}</button>` : ""}${c.status === "locked" ? `<button class="btn" type="button" data-v-reject="${esc(c.folio)}">${t.reject}</button>` : ""}</span></summary>
    <div class="scroll" style="margin-top:10px"><table class="stack"><thead><tr><th>${t.files}</th><th>${t.status}</th><th>${t.size}</th><th>${t.scan}</th><th>${t.hash}</th><th>${t.prof}</th></tr></thead><tbody>
    ${filesOf(c.folio).map(f => `<tr><td>${esc(f.original_name)}</td><td>${esc(f.status)}</td><td class="n">${mb(+f.size_bytes)}</td><td>${esc(f.scan_status)}</td><td><code>${esc((f.sha256_master || f.sha256_staging || f.sha256_upload || "").slice(0, 16))}…</code></td><td>${esc(prof(f.profile))}</td></tr>`).join("")}</tbody></table></div></details>`).join("") : `<p class="sub">${t.none2}</p>`;

  const pending = data.files.filter(f => f.status !== "ingested" && !data.corpora.find(c => c.folio === f.folio));
  const pend = pending.length ? `<p class="note">${pending.length} file(s) in staging / quarantine / failed: ${pending.slice(0, 8).map(f => `${esc(f.folio)} ${esc(f.original_name)} (${esc(f.status)})`).join(", ")}</p>` : "";

  const today = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const engForm = `<form id="v-eng" class="card" style="max-width:none;margin:0 0 14px"><h3 style="font-size:18px">${t.newEng}</h3><div class="fields">
    <div class="f"><label for="ve-b">${t.buyer}</label><input id="ve-b" name="buyer_name" required maxlength="120"></div>
    <div class="f"><label for="ve-f">${t.folios}</label><input id="ve-f" name="folios" required placeholder="DP-2026-0001"></div>
    <div class="f"><label for="ve-k">${t.kind}</label><select id="ve-k" name="kind" style="width:100%;min-height:48px;border-radius:10px;background:var(--field);border:1.5px solid var(--line);padding:0 10px"><option value="buyer">${t.buyerK}</option><option value="internal_review">${t.internalK}</option></select></div>
    <div class="f"><label for="ve-r">${t.red}</label><select id="ve-r" name="redaction_mode" style="width:100%;min-height:48px;border-radius:10px;background:var(--field);border:1.5px solid var(--line);padding:0 10px"><option value="pii">${t.pii}</option><option value="none">${t.none}</option></select></div>
    <div class="f"><label for="ve-c">${t.cols}</label><input id="ve-c" name="columns" maxlength="400"></div>
    <div class="f"><label for="ve-e">${t.ends}</label><input id="ve-e" name="expires_at" type="date" required value="${today}"></div></div>
    <div class="nav"><button class="btn go" type="submit">${t.create}</button></div></form>`;

  const eng = data.engagements.length ? `<div class="scroll"><table class="stack"><thead><tr><th>${t.buyer}</th><th>Folios</th><th>${t.status}</th><th>${t.files}</th><th>${t.ends}</th><th>${t.viewers}</th><th></th></tr></thead><tbody>${data.engagements.map(e => `<tr>
    <td><b>${esc(e.buyer_name)}</b><br><span class="sub">${esc(e.kind)} · ${esc(e.redaction && e.redaction.mode)}</span></td><td>${esc((e.folios || []).join(", "))}</td>
    <td>${esc(e.status)}${e.last_error ? `<br><span class="err">${esc(e.last_error)}</span>` : ""}</td><td class="n">${e.files}${e.withheld && e.withheld.length ? ` <span class="sub">(+${e.withheld.length} ${t.withheld})</span>` : ""}</td>
    <td>${dt(e.expires_at)}</td><td>${(e.viewers || []).map(v => `${esc(v.email)}${v.revoked ? " ✕" : ""}`).join("<br>")}</td>
    <td style="white-space:nowrap">${["ready", "requested", "building", "failed"].includes(e.status) ? `<button class="btn" type="button" data-v-invite="${esc(e.id)}">${t.invite}</button> <button class="btn" type="button" data-v-rebuild="${esc(e.id)}">${t.rebuild}</button> <button class="btn" type="button" data-v-revoke="${esc(e.id)}">${t.revoke}</button>` : ""}</td></tr>
    ${inviteFor === e.id ? `<tr><td colspan="7"><form id="v-inv" data-id="${esc(e.id)}" style="display:flex;gap:10px;flex-wrap:wrap;align-items:end"><div class="f"><label for="vi-n">${t.name}</label><input id="vi-n" name="name" required></div><div class="f"><label for="vi-e">${t.email}</label><input id="vi-e" name="email" type="email" required></div><button class="btn go" type="submit">${t.send}</button></form></td></tr>` : ""}`).join("")}</tbody></table></div>` : `<p class="sub">${t.none2}</p>`;

  const secretBox = secret ? `<div class="cant" style="margin:12px 0"><h3>${t.once}</h3><p>${t.link}: <code>${esc(secret.link)}</code></p><p>${t.code}: <b style="font-size:22px;letter-spacing:.1em">${esc(secret.code)}</b></p></div>` : "";
  const delBox = `<form id="v-del" style="display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin:8px 0 18px"><div class="f"><label for="vd-f">${t.dl}</label><input id="vd-f" name="folio" placeholder="DP-2026-0001" required pattern="DP-\\d{4}-\\d{4,}"></div><button class="btn" type="submit">${t.mk}</button></form>${deliver ? `<p class="note">${t.once}<br><code>${esc(deliver)}</code></p>` : ""}`;

  const sess = data.sessions.length ? `<div class="scroll"><table class="stack"><thead><tr><th>${t.email}</th><th>${t.buyer}</th><th>Start</th><th>Last</th><th>Pages</th><th>⚠</th><th>${t.status}</th><th></th></tr></thead><tbody>${data.sessions.map(s => `<tr><td>${esc(s.email)}</td><td>${esc(s.buyer_name)}</td><td>${dt(s.started_at)}</td><td>${dt(s.last_seen)}</td><td class="n">${s.page_views}</td><td class="n">${s.warnings}</td><td>${s.ended_at ? esc(s.end_reason) : `<b class="pass">${t.open}</b>`}</td><td>${s.ended_at ? "" : `<button class="btn" type="button" data-v-cut="${esc(s.id)}">${t.cut}</button>`}</td></tr>`).join("")}</tbody></table></div>` : `<p class="sub">${t.none2}</p>`;

  const aud = `<form id="v-aud" style="display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin-bottom:10px"><div class="f"><label for="va-f">${t.folio}</label><input id="va-f" name="folio" value="${esc(filters.folio)}"></div><div class="f"><label for="va-a">${t.action}</label><input id="va-a" name="action" value="${esc(filters.action)}" placeholder="room. / ingest. / admin."></div><button class="btn" type="submit">${t.filter}</button><button class="btn" type="button" id="v-chain">${t.verifyChain}</button></form>
    ${chain ? `<p class="${chain.ok ? "pass" : "miss"}">${chain.ok ? t.chainOk(chain.total) : t.chainBad(chain.first_broken)}</p>` : ""}
    <div class="scroll"><table class="stack"><thead><tr><th>#</th><th>Time</th><th>Actor</th><th>${t.action}</th><th>${t.folio}</th><th>Detail</th></tr></thead><tbody>${auditRows.map(a => `<tr><td class="n">${a.id}</td><td style="white-space:nowrap">${dt(a.at)}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(a.folio || "")}</td><td><code style="font-size:12px">${esc(JSON.stringify(a.detail)).slice(0, 220)}</code></td></tr>`).join("")}</tbody></table></div>`;

  return `${err ? `<p class="err">${esc(err)}</p>` : ""}<p class="note">${t.jobs}: ${esc(jobs || "—")}</p>
    <h3 style="font-size:20px">${t.corp}</h3><p class="sub">${t.gate}</p>${corp}${pend}${delBox}
    <h3 style="font-size:20px;margin-top:24px">${t.eng}</h3>${secretBox}${engForm}${eng}
    <h3 style="font-size:20px;margin-top:24px">${t.sess}</h3>${sess}
    <h3 style="font-size:20px;margin-top:24px">${t.aud}</h3>${aud}`;
}

// returns true when it handled the event (admin.js then re-renders)
async function handle(e, lang) {
  const t = V[lang] || V.en, b = e.target.closest && e.target.closest("button");
  try {
    if (e.type === "click" && b) {
      if (b.dataset.vVerify) { await call("POST", `/api/admin/vault/corpora/${encodeURIComponent(b.dataset.vVerify)}/verify`, {}); }
      else if (b.dataset.vReject) { await call("POST", `/api/admin/vault/corpora/${encodeURIComponent(b.dataset.vReject)}/reject`, {}); }
      else if (b.dataset.vRebuild) { await call("POST", `/api/admin/vault/engagements/${b.dataset.vRebuild}/rebuild`, {}); }
      else if (b.dataset.vRevoke) { if (!window.confirm(t.confirmRevoke)) return false; await call("POST", `/api/admin/vault/engagements/${b.dataset.vRevoke}/revoke`, {}); }
      else if (b.dataset.vInvite) { inviteFor = inviteFor === b.dataset.vInvite ? null : b.dataset.vInvite; secret = null; return true; }
      else if (b.dataset.vCut) { await call("POST", `/api/admin/vault/sessions/${b.dataset.vCut}/cut`, {}); }
      else if (b.id === "v-chain") { chain = await call("GET", "/api/admin/vault/audit/verify"); return true; }
      else return false;
      await load(); return true;
    }
    if (e.type === "submit") {
      const f = e.target, fd = Object.fromEntries(new FormData(f));
      if (f.id === "v-eng") { e.preventDefault(); await call("POST", "/api/admin/vault/engagements", fd); f.reset(); await load(); return true; }
      if (f.id === "v-inv") { e.preventDefault(); secret = await call("POST", `/api/admin/vault/engagements/${f.dataset.id}/viewers`, fd); inviteFor = null; await load(); return true; }
      if (f.id === "v-del") { e.preventDefault(); deliver = (await call("POST", `/api/admin/submissions/${encodeURIComponent(fd.folio)}/upload-link`, {})).url; return true; }
      if (f.id === "v-aud") { e.preventDefault(); filters = { folio: fd.folio || "", action: fd.action || "" }; await load(); return true; }
    }
  } catch (x) { err = x.message; return true; }
  return false;
}

return { label: lang => (V[lang] || V.en).tab, load, render, handle };
})();
