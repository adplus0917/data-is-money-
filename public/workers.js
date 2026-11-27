// Admin page for worker (non-admin) data-room accounts: create
// workers, assign customers, place working files, review the access
// log. Uses the team-panel admin session (staff admin role or the
// shared admin login) — the API enforces it.
const $ = (id) => document.getElementById(id);
async function api(path, opts) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
  return data;
}
let state = { workers: [], assignments: [] };

async function load() {
  try {
    state = await api("/api/admin/console/workers");
  } catch {
    $("signed-out").classList.remove("hidden");
    $("app").classList.add("hidden");
    return;
  }
  $("signed-out").classList.add("hidden");
  $("app").classList.remove("hidden");
  renderWorkers();
  loadAccess();
}

function renderWorkers() {
  const box = $("workers");
  box.innerHTML = "";
  if (!state.workers.length) {
    box.innerHTML = '<p class="muted">No worker accounts yet. Create the first one above.</p>';
    return;
  }
  const table = document.createElement("table");
  table.innerHTML = "<tr><th>Worker</th><th>Assigned customers</th><th>Assign (folio)</th><th>Status</th></tr>";
  for (const w of state.workers) {
    const tr = document.createElement("tr");
    const mine = state.assignments.filter((a) => a.worker_id === w.id);
    const td1 = document.createElement("td");
    td1.innerHTML = "<strong></strong><br><span class='muted'></span>";
    td1.querySelector("strong").textContent = w.name;
    td1.querySelector("span").textContent = w.username + (w.last_login_at ? " · last sign-in " + new Date(w.last_login_at).toLocaleString() : " · never signed in");
    const td2 = document.createElement("td");
    if (!mine.length) td2.innerHTML = '<span class="muted">none</span>';
    for (const a of mine) {
      const line = document.createElement("div");
      line.textContent = a.folio + " ";
      const un = document.createElement("button");
      un.className = "ghost small";
      un.textContent = "remove";
      un.addEventListener("click", async () => {
        await api(`/api/admin/console/workers/${w.id}/unassign`, { method: "POST", body: JSON.stringify({ folio: a.folio }) });
        load();
      });
      line.appendChild(un);
      td2.appendChild(line);
    }
    const td3 = document.createElement("td");
    const inp = document.createElement("input");
    inp.placeholder = "DP-2026-0001";
    inp.style.width = "130px";
    const btn = document.createElement("button");
    btn.className = "small";
    btn.textContent = "Assign";
    btn.addEventListener("click", async () => {
      try {
        await api(`/api/admin/console/workers/${w.id}/assign`, { method: "POST", body: JSON.stringify({ folio: inp.value.trim() }) });
        load();
      } catch (e) { alert(e.message); }
    });
    td3.appendChild(inp);
    td3.appendChild(document.createTextNode(" "));
    td3.appendChild(btn);
    const td4 = document.createElement("td");
    const tog = document.createElement("button");
    tog.className = "ghost small";
    tog.textContent = w.active ? "Active — deactivate" : "Deactivated — activate";
    tog.addEventListener("click", async () => {
      await api(`/api/admin/console/workers/${w.id}/active`, { method: "POST", body: JSON.stringify({ active: !w.active }) });
      load();
    });
    td4.appendChild(tog);
    tr.append(td1, td2, td3, td4);
    table.appendChild(tr);
  }
  box.appendChild(table);
}

async function loadAccess() {
  try {
    const { access } = await api("/api/admin/console/workers/access");
    const box = $("access");
    if (!access.length) { box.innerHTML = '<p class="muted">No worker activity yet.</p>'; return; }
    const table = document.createElement("table");
    table.innerHTML = "<tr><th>When</th><th>Worker</th><th>Action</th><th>Customer</th><th>File</th></tr>";
    for (const a of access) {
      const tr = document.createElement("tr");
      const cells = [new Date(a.created_at).toLocaleString(), a.username || "", a.action, a.folio || "", (a.folder ? a.folder + " / " : "") + (a.file_name || "")];
      for (const c of cells) {
        const td = document.createElement("td");
        td.textContent = c;
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    box.innerHTML = "";
    box.appendChild(table);
  } catch { /* access log is best-effort in the UI */ }
}

$("create-btn").addEventListener("click", async () => {
  $("create-err").textContent = "";
  $("create-ok").textContent = "";
  try {
    const { worker } = await api("/api/admin/console/workers", {
      method: "POST",
      body: JSON.stringify({ username: $("new-username").value, name: $("new-name").value, password: $("new-password").value }),
    });
    $("create-ok").textContent = `Created ${worker.username}. They can sign in at /work now — assign them a customer below.`;
    $("new-username").value = "";
    $("new-name").value = "";
    $("new-password").value = "";
    load();
  } catch (e) {
    $("create-err").textContent = e.message;
  }
});
load();
