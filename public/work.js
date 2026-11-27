// Worker page (/work): sign in, list assigned customers and their
// folders, open working files. Masters are listed for awareness but
// the API refuses to open them — the refusal is shown, and logged.
const $ = (id) => document.getElementById(id);
const fmtSize = (n) => {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
};
async function api(path, opts) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
  return data;
}

async function boot() {
  try {
    const me = await api("/api/worker/me");
    $("who").textContent = me.name + " (" + me.username + ")";
    $("logout").classList.remove("hidden");
    $("login").classList.add("hidden");
    $("app").classList.remove("hidden");
    await loadCustomers();
  } catch {
    $("login").classList.remove("hidden");
    $("app").classList.add("hidden");
  }
}

async function loadCustomers() {
  const { customers } = await api("/api/worker/customers");
  const box = $("customers");
  box.innerHTML = "";
  if (!customers.length) {
    box.innerHTML = '<div class="card muted">No customers are assigned to you yet. Ask your admin to assign one.</div>';
    return;
  }
  for (const c of customers) {
    const div = document.createElement("div");
    div.className = "card customer";
    div.innerHTML = "<strong></strong> <span class='muted'></span><div class='muted'></div>";
    div.querySelector("strong").textContent = c.company_name || c.folio;
    div.querySelector("span").textContent = c.folio;
    div.querySelector("div").textContent = c.folders.map((f) => `${f.folder}: ${f.files}`).join(" · ");
    div.addEventListener("click", () => loadDetail(c.folio));
    box.appendChild(div);
  }
}

async function loadDetail(folio) {
  const detail = $("detail");
  detail.innerHTML = '<div class="card muted">Loading…</div>';
  try {
    const data = await api("/api/worker/customers/" + encodeURIComponent(folio));
    const card = document.createElement("div");
    card.className = "card";
    const h = document.createElement("h3");
    h.style.marginTop = "0";
    h.textContent = folio;
    card.appendChild(h);
    for (const f of data.folders) {
      const sec = document.createElement("div");
      sec.className = "folder";
      const title = document.createElement("h4");
      title.textContent = f.folder + (f.locked ? " 🔒" : "");
      sec.appendChild(title);
      if (!f.files.length) {
        const p = document.createElement("div");
        p.className = "muted";
        p.textContent = "No files yet.";
        sec.appendChild(p);
      }
      for (const file of f.files) {
        const row = document.createElement("div");
        row.className = "file";
        const left = document.createElement("span");
        left.textContent = file.name + " ";
        const size = document.createElement("span");
        size.className = "muted";
        size.textContent = fmtSize(file.size) + (file.locked ? " · master — view only by admins" : "");
        left.appendChild(size);
        const btn = document.createElement("button");
        btn.className = "small" + (file.locked ? " ghost" : "");
        btn.textContent = file.locked ? "Open (locked)" : "Open";
        btn.addEventListener("click", () => openFile(folio, f.folder, file, btn));
        row.appendChild(left);
        row.appendChild(btn);
        sec.appendChild(row);
      }
      card.appendChild(sec);
    }
    detail.innerHTML = "";
    detail.appendChild(card);
  } catch (e) {
    detail.innerHTML = "";
    const div = document.createElement("div");
    div.className = "card err";
    div.textContent = e.message;
    detail.appendChild(div);
  }
}

async function openFile(folio, folder, file, btn) {
  btn.disabled = true;
  try {
    const { url } = await api("/api/worker/customers/" + encodeURIComponent(folio) + "/open", {
      method: "POST",
      body: JSON.stringify({ folder, source: file.source, file_id: file.id }),
    });
    window.open(url, "_blank", "noopener");
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
  }
}

$("login-btn").addEventListener("click", async () => {
  $("login-err").textContent = "";
  try {
    await api("/api/worker/login", {
      method: "POST",
      body: JSON.stringify({ username: $("username").value, password: $("password").value }),
    });
    await boot();
  } catch (e) {
    $("login-err").textContent = e.message;
  }
});
$("logout").addEventListener("click", async () => {
  await api("/api/worker/logout", { method: "POST" }).catch(() => {});
  location.reload();
});
boot();
