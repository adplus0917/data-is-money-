// ============================================================
// OWNER CRM + staff console (mounted by server/index.js).
// One login opens the WHOLE pipeline: every file with its stage, days
// in stage, assigned staff member, valuation band and offer state; the
// per-file record (timeline, missing-items checklist, stuck reason,
// conversation thread); the missing-items back-and-forth loop; the
// workload view; the offer board; the partner queue; the outbox.
//
// Judgment steps stay human: file selection, recording offers, and
// accepting/rejecting them. Everything else here is bookkeeping the
// system does by itself. Seller-visible statuses NEVER change from
// this module — they move only on the real pipeline events.
// ============================================================
const crypto = require("crypto");
const staff = require("./staff");
const outbox = require("./outbox");
const opt = require("./options");

const REASON_CATEGORIES = ["waiting_seller_docs", "in_analysis", "out_with_buyers", "offers_too_low", "buyer_questions_pending", "other"];
const ANALYSIS_MAX_DAYS = 10;          // Miguel's analysis window: 3–10 days
const NO_BUYER_ACTIVITY_DAYS = 7;      // engagement open this long with zero page views = stuck

module.exports = function mount(app, { db, limiter, log }) {
  const audit = entry => (log ? log(entry) : Promise.resolve());
  const pub = u => u && ({ id: u.id, email: u.email, name: u.name, role: u.role, active: u.active, created_by: u.created_by, created_at: u.created_at });

  /* ================= staff accounts ================= */
  app.post("/api/admin/staff/login", limiter(8, 60e3), async (req, res) => {
    const email = String((req.body && req.body.email) || "").toLowerCase().trim();
    const pw = String((req.body && req.body.password) || "");
    const u = await db.getStaffByEmail(email);
    if (!u || !u.active || !staff.verifyPassword(pw, u.password_hash)) {
      audit({ actor: `staff-login@${req.ip}`, action: "staff.login_failed", detail: { email } });
      return res.status(401).json({ error: "wrong email or password" });
    }
    audit({ actor: `staff:${u.email}`, action: "staff.login" });
    staff.issue(res, u);
    res.json({ ok: true, staff: pub(u) });
  });
  app.post("/api/admin/staff/logout", (req, res) => { staff.clear(res); res.json({ ok: true }); });
  app.get("/api/admin/staff/me", (req, res) => {
    const w = staff.who(req);
    res.json(w ? { signedIn: true, staff: { email: w.email, name: w.name, role: w.role, legacy: !!w.legacy } } : { signedIn: false });
  });

  app.get("/api/admin/staff", staff.guard, staff.requireAdminRole, async (req, res) => res.json(await db.listStaff()));
  app.post("/api/admin/staff", staff.guard, staff.requireAdminRole, async (req, res) => {
    const b = req.body || {};
    const email = String(b.email || "").toLowerCase().trim();
    const name = opt.str(b.name, 120);
    const role = b.role === "admin" ? "admin" : "ops";
    if (!name || opt.emailError(email)) return res.status(400).json({ error: "name and a valid email are required" });
    if (!b.password || String(b.password).length < 10) return res.status(400).json({ error: "password must be at least 10 characters" });
    if (await db.getStaffByEmail(email)) return res.status(409).json({ error: "a staff account with that email already exists" });
    const u = await db.createStaff({ id: crypto.randomUUID(), email, name, role, password_hash: staff.hashPassword(b.password), created_by: staff.actorOf(req) });
    audit({ actor: staff.actorOf(req), action: "staff.created", detail: { email, role } });
    res.status(201).json(pub(u));
  });
  app.patch("/api/admin/staff/:id", staff.guard, staff.requireAdminRole, async (req, res) => {
    const b = req.body || {}, p = {};
    if (b.name !== undefined) p.name = opt.str(b.name, 120);
    if (b.role !== undefined) p.role = b.role === "admin" ? "admin" : "ops";
    if (b.active !== undefined) p.active = !!b.active;
    if (b.password !== undefined) {
      if (String(b.password).length < 10) return res.status(400).json({ error: "password must be at least 10 characters" });
      p.password_hash = staff.hashPassword(b.password);
    }
    const u = await db.updateStaff(req.params.id, p);
    if (!u) return res.status(404).json({ error: "staff account not found" });
    audit({ actor: staff.actorOf(req), action: "staff.updated", detail: { staff: u.email, fields: Object.keys(p) } });
    res.json(pub(u));
  });

  /* ================= dashboard computation ================= */
  async function buildFiles() {
    const subs = await db.listSubmissions();
    const notes = {}, checkOpen = {}, histBy = {};
    await Promise.all(subs.map(async s => {
      const [n, c, h] = await Promise.all([db.getFileNote(s.folio), db.listChecklist(s.folio), db.listStatusHistory(s.folio)]);
      notes[s.folio] = n; checkOpen[s.folio] = c.filter(i => i.status !== "received").length; histBy[s.folio] = h;
    }));
    // Vault-side state (Postgres deployments only): corpus + engagements + offers per folio
    const corpus = {}, engBy = {}, offerBy = {};
    if (db.pool) {
      const [c, e, o] = await Promise.all([
        db.pool.query(`SELECT folio, status FROM corpora`),
        db.pool.query(`SELECT e.folios, e.status, e.created_at,
                          (SELECT coalesce(sum(s.page_views),0)::int FROM viewer_sessions s WHERE s.engagement_id=e.id) AS views
                       FROM engagements e ORDER BY e.created_at DESC`),
        db.pool.query(`SELECT folio, count(*)::int AS n, max(amount) AS best, count(*) FILTER (WHERE status='open')::int AS open_n FROM offers WHERE folio IS NOT NULL GROUP BY folio`),
      ]);
      for (const r of c.rows) corpus[r.folio] = r.status;
      for (const r of e.rows) for (const f of r.folios || []) if (!engBy[f]) engBy[f] = r;   // latest engagement per folio
      for (const r of o.rows) offerBy[r.folio] = r;
    }
    const now = Date.now();
    return subs.map(s => {
      const hist = histBy[s.folio] || [];
      const entered = [...hist].reverse().find(h => h.status === s.status);
      const stageSince = entered ? entered.changed_at : s.created_at;
      const days = Math.max(0, Math.floor((now - new Date(stageSince).getTime()) / 864e5));
      const eng = engBy[s.folio] || null;
      const stuckReasons = [];
      if (s.status === "Muestra recibida" && days > ANALYSIS_MAX_DAYS) stuckReasons.push("analysis_overdue");
      if (eng && eng.status === "ready" && (now - new Date(eng.created_at).getTime()) / 864e5 > NO_BUYER_ACTIVITY_DAYS && Number(eng.views) === 0) stuckReasons.push("no_buyer_activity");
      return {
        folio: s.folio, company_name: s.company_name, owner_name: s.owner_name, email: s.email, phone: s.phone,
        sector: s.sector, track: s.track, stage: s.status, stage_since: stageSince, days_in_stage: days,
        assigned_to: s.assigned_to || null,
        estimate_low: s.estimate_low, estimate_high: s.estimate_high, tier: s.tier, score: s.score,
        corpus_status: corpus[s.folio] || null,
        engagement: eng ? { status: eng.status, views: Number(eng.views) } : null,
        offers: offerBy[s.folio] ? { count: offerBy[s.folio].n, open: offerBy[s.folio].open_n, best: offerBy[s.folio].best } : { count: 0, open: 0, best: null },
        checklist_open: checkOpen[s.folio] || 0,
        stuck: stuckReasons.length > 0, stuck_reasons: stuckReasons,
        note: notes[s.folio] || null,
        created_at: s.created_at,
      };
    });
  }

  app.get("/api/admin/console/dashboard", staff.guard, async (req, res) => {
    let files = await buildFiles();
    const { stage, agent, stuck } = req.query;
    if (stage) files = files.filter(f => f.stage === stage);
    if (agent === "unassigned") files = files.filter(f => !f.assigned_to);
    else if (agent) files = files.filter(f => f.assigned_to === agent);
    if (stuck === "1" || stuck === "true") files = files.filter(f => f.stuck);
    res.json({ files, total: files.length });
  });

  app.get("/api/admin/console/workload", staff.guard, async (req, res) => {
    const files = await buildFiles();
    const byAgent = {}, byStage = {};
    for (const f of files) {
      const k = f.assigned_to || "unassigned";
      byAgent[k] = byAgent[k] || { agent: k, files: 0, days: 0, stuck: 0 };
      byAgent[k].files++; byAgent[k].days += f.days_in_stage; if (f.stuck) byAgent[k].stuck++;
      byStage[f.stage] = (byStage[f.stage] || 0) + 1;
    }
    res.json({
      agents: Object.values(byAgent).map(a => ({ ...a, avg_days_in_stage: a.files ? Math.round((a.days / a.files) * 10) / 10 : 0 })),
      stages: byStage, total_files: files.length, stuck_files: files.filter(f => f.stuck).length,
    });
  });

  /* ================= per-file record ================= */
  app.get("/api/admin/console/files/:folio", staff.guard, async (req, res) => {
    const folio = String(req.params.folio);
    const subs = await db.listSubmissions();
    const sub = subs.find(s => s.folio === folio);
    if (!sub) return res.status(404).json({ error: "folio not found" });
    const [history, thread, checklist, note, offers] = await Promise.all([
      db.listStatusHistory(folio), db.listFileMessages(folio), db.listChecklist(folio), db.getFileNote(folio), db.listOffers({ folio }),
    ]);
    const out = { submission: sub, history, thread, checklist, note, offers, files: null, corpus: null, engagements: null };
    if (db.pool) {
      const [f, c, e] = await Promise.all([
        db.pool.query(`SELECT id, kind, original_name, ext, size_bytes, scan_status, status, profile, created_at, ingested_at FROM upload_files WHERE folio=$1 ORDER BY created_at`, [folio]),
        db.pool.query(`SELECT * FROM corpora WHERE folio=$1`, [folio]),
        db.pool.query(`SELECT id, buyer_name, partner_name, partner_email, status, expires_at, created_at, manifest, withheld FROM engagements WHERE folios @> $1::text[] ORDER BY created_at DESC`, [JSON.stringify([folio])]),
      ]);
      out.files = f.rows; out.corpus = c.rows[0] || null; out.engagements = e.rows;
    }
    res.json(out);
  });

  app.post("/api/admin/console/files/:folio/assign", staff.guard, async (req, res) => {
    const email = req.body && req.body.assigned_to ? String(req.body.assigned_to).toLowerCase().trim() : null;
    if (email && !(await db.getStaffByEmail(email))) return res.status(400).json({ error: "assigned_to must be a staff email (or null to unassign)" });
    const ok = await db.setAssignment(String(req.params.folio), email);
    if (!ok) return res.status(404).json({ error: "folio not found" });
    audit({ actor: staff.actorOf(req), action: "crm.assign", folio: String(req.params.folio), detail: { assigned_to: email } });
    res.json({ ok: true, assigned_to: email });
  });

  app.put("/api/admin/console/files/:folio/note", staff.guard, async (req, res) => {
    const b = req.body || {};
    if (b.reason_category && !REASON_CATEGORIES.includes(b.reason_category)) return res.status(400).json({ error: "unknown reason category" });
    const subs = await db.listSubmissions();
    if (!subs.some(s => s.folio === String(req.params.folio))) return res.status(404).json({ error: "folio not found" });
    const n = await db.setFileNote(String(req.params.folio), {
      reason_category: b.reason_category || null, note: opt.str(b.note, 2000), next_action: opt.str(b.next_action, 500),
      action_owner: opt.str(b.action_owner, 200), updated_by: staff.actorOf(req),
    });
    audit({ actor: staff.actorOf(req), action: "crm.note", folio: String(req.params.folio), detail: { reason_category: n.reason_category, next_action: n.next_action } });
    res.json(n);
  });

  /* ================= missing-items checklist + the loop ================= */
  app.get("/api/admin/console/files/:folio/checklist", staff.guard, async (req, res) => res.json(await db.listChecklist(String(req.params.folio))));
  app.post("/api/admin/console/files/:folio/checklist", staff.guard, async (req, res) => {
    const b = req.body || {};
    const label = opt.str(b.label, 300);
    if (!label) return res.status(400).json({ error: "label required" });
    const subs = await db.listSubmissions();
    if (!subs.some(s => s.folio === String(req.params.folio))) return res.status(404).json({ error: "folio not found" });
    const item = await db.addChecklistItem({
      folio: String(req.params.folio), label, expect: opt.str(b.expect, 120) || null,
      source: ["manifest", "analysis", "staff"].includes(b.source) ? b.source : "staff", created_by: staff.actorOf(req),
    });
    audit({ actor: staff.actorOf(req), action: "crm.checklist_add", folio: item.folio, detail: { item: item.id, label } });
    res.status(201).json(item);
  });
  app.patch("/api/admin/console/checklist/:id", staff.guard, async (req, res) => {
    const b = req.body || {}, p = {};
    if (b.label !== undefined) p.label = opt.str(b.label, 300);
    if (b.expect !== undefined) p.expect = opt.str(b.expect, 120) || null;
    if (b.status !== undefined) {
      if (!["missing", "requested", "received"].includes(b.status)) return res.status(400).json({ error: "unknown status" });
      p.status = b.status;
    }
    const item = await db.updateChecklistItem(Number(req.params.id), p);
    if (!item) return res.status(404).json({ error: "checklist item not found" });
    audit({ actor: staff.actorOf(req), action: "crm.checklist_update", folio: item.folio, detail: { item: item.id, status: item.status } });
    res.json(item);
  });

  // One click: turn the open checklist into a missing-items request on the
  // seller's channels — thread entry on the file record + email via the
  // outbox (+ a WhatsApp-Web queue entry when the seller has a phone).
  app.post("/api/admin/console/files/:folio/request-items", staff.guard, async (req, res) => {
    const folio = String(req.params.folio);
    const subs = await db.listSubmissions();
    const sub = subs.find(s => s.folio === folio);
    if (!sub) return res.status(404).json({ error: "folio not found" });
    let items = (await db.listChecklist(folio)).filter(i => i.status !== "received");
    const wanted = Array.isArray(req.body && req.body.item_ids) ? req.body.item_ids.map(Number) : null;
    if (wanted) items = items.filter(i => wanted.includes(i.id));
    if (!items.length) return res.status(400).json({ error: "no open checklist items to request" });
    const list = items.map(i => `• ${i.label}`).join("\n");
    const text =
`Hola ${sub.owner_name}, te escribimos de DATA Patrimonio sobre tu archivo ${folio} (${sub.company_name}).

Para completar el análisis todavía nos falta esto:
${list}

Súbelo con tu enlace privado de entrega. En cuanto lo recibamos, tu archivo avanza y te avisamos.

— Equipo DATA Patrimonio

Hi ${sub.owner_name}, this is DATA Patrimonio about your file ${folio} (${sub.company_name}).

To finish the analysis we still need:
${list}

Please upload it with your private delivery link. As soon as we receive it, your file moves forward and we will let you know.

— DATA Patrimonio team`;
    const actor = staff.actorOf(req);
    const thread = await db.addFileMessage({ folio, direction: "out", kind: "missing_request", author: actor, text });
    const queued = [];
    if (sub.email) queued.push(await outbox.queue(db, {
      kind: "seller_missing_items", channel: "email", to_email: sub.email, to_name: sub.owner_name,
      subject: `DATA Patrimonio · Tu archivo ${folio}: documentos pendientes / Missing items`, body: text, folio, created_by: actor,
    }));
    if (sub.phone) queued.push(await outbox.queue(db, {
      kind: "seller_missing_items", channel: "whatsapp", to_email: sub.phone, to_name: sub.owner_name,
      subject: null, body: text, folio, created_by: actor,
    }));
    for (const i of items) await db.updateChecklistItem(i.id, { status: "requested" });
    audit({ actor, action: "crm.missing_request", folio, detail: { items: items.map(i => i.id), outbox: queued.map(q => ({ id: q.id, channel: q.channel, status: q.status })) } });
    res.status(201).json({ ok: true, thread_id: thread.id, items: items.map(i => i.id), outbox: queued.map(q => ({ id: q.id, channel: q.channel, status: q.status })) });
  });

  // Seller replies (from the portal / email / WhatsApp) are logged onto the
  // file record, so the whole back-and-forth lives in one place.
  app.post("/api/admin/console/files/:folio/thread", staff.guard, async (req, res) => {
    const b = req.body || {};
    const text = opt.str(b.text, 4000);
    if (!text) return res.status(400).json({ error: "text required" });
    const subs = await db.listSubmissions();
    if (!subs.some(s => s.folio === String(req.params.folio))) return res.status(404).json({ error: "folio not found" });
    const m = await db.addFileMessage({
      folio: String(req.params.folio), direction: b.direction === "in" ? "in" : "out",
      kind: b.direction === "in" ? "reply" : "note", author: staff.actorOf(req), text,
    });
    res.status(201).json(m);
  });

  /* ================= offer board ================= */
  app.get("/api/admin/console/offers", staff.guard, async (req, res) => {
    res.json(await db.listOffers({ folio: req.query.folio || null, engagement_id: req.query.engagement_id || null }));
  });
  app.post("/api/admin/console/offers", staff.guard, async (req, res) => {
    const b = req.body || {};
    const partner = opt.str(b.partner_name, 160);
    const amount = Number(b.amount);
    if (!partner || !(amount > 0)) return res.status(400).json({ error: "partner_name and a positive amount are required" });
    const o = await db.addOffer({
      folio: b.folio || null, engagement_id: b.engagement_id || null, partner_name: partner,
      partner_email: opt.str(b.partner_email, 200) || null, amount, currency: opt.str(b.currency, 3) || "USD",
      terms_note: opt.str(b.terms_note, 1000) || null, recorded_by: staff.actorOf(req),
    });
    audit({ actor: staff.actorOf(req), action: "offer.recorded", folio: o.folio, engagement_id: o.engagement_id, detail: { offer: o.id, partner, amount } });
    res.status(201).json(o);
  });
  app.patch("/api/admin/console/offers/:id", staff.guard, async (req, res) => {
    const decision = req.body && req.body.decision;
    if (!["accepted", "rejected"].includes(decision)) return res.status(400).json({ error: "decision must be accepted or rejected" });
    const o = await db.decideOffer(Number(req.params.id), decision, staff.actorOf(req));
    if (!o) return res.status(404).json({ error: "offer not found or already decided" });
    // Human decision only. The seller-visible status does NOT move here:
    // it advances solely through the real quality-gate / pipeline events.
    audit({ actor: staff.actorOf(req), action: "offer." + decision, folio: o.folio, engagement_id: o.engagement_id, detail: { offer: o.id, partner: o.partner_name, amount: o.amount } });
    res.json(o);
  });

  /* ================= outbox + partner queue ================= */
  app.get("/api/admin/console/outbox", staff.guard, async (req, res) => res.json(await db.listOutbox()));
  app.post("/api/admin/console/outbox/:id/send", staff.guard, async (req, res) => {
    const row = await db.getOutbox(Number(req.params.id));
    if (!row) return res.status(404).json({ error: "outbox row not found" });
    const after = await outbox.attempt(db, row);
    audit({ actor: staff.actorOf(req), action: "outbox.send_attempt", folio: row.folio, engagement_id: row.engagement_id, detail: { outbox: row.id, status: after.status } });
    res.json(after);
  });

  app.get("/api/admin/console/partner-messages", staff.guard, async (req, res) => {
    res.json(await db.listPartnerMessages(req.query.engagement_id || null));
  });
  app.post("/api/admin/console/partner-messages", staff.guard, async (req, res) => {
    const b = req.body || {};
    const text = opt.str(b.text, 4000);
    if (!text || !["in", "out"].includes(b.direction)) return res.status(400).json({ error: "direction (in|out) and text are required" });
    const m = await db.addPartnerMessage({
      engagement_id: b.engagement_id || null, folio: b.folio || null, direction: b.direction,
      channel: b.channel === "whatsapp" ? "whatsapp" : "email",
      author: b.direction === "in" ? (opt.str(b.author, 200) || "partner") : staff.actorOf(req), text,
    });
    if (b.direction === "out") audit({ actor: staff.actorOf(req), action: "partner.message_out", folio: m.folio, engagement_id: m.engagement_id, detail: { channel: m.channel } });
    res.status(201).json(m);
  });

  return { buildFiles };
};
