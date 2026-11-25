// ============================================================
// Database layer — the ONLY file that talks to storage.
// Production: PostgreSQL (set DATABASE_URL).
// Local testing with no database installed: a JSON file in ./data
// (set nothing). Both expose the same functions, so nothing else
// in the app changes when you switch.
// ============================================================
const fs = require("fs");
const path = require("path");

const YEAR = () => new Date().getFullYear();
const folioOf = (year, n) => `DP-${year}-${String(n).padStart(4, "0")}`;

/* ---------------- PostgreSQL ---------------- */
function postgres(url) {
  const { Pool } = require("pg");
  const ssl = process.env.PGSSL === "false" ? false : (/localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false });
  const pool = new Pool({ connectionString: url, ssl, max: 10 });

  return {
    kind: "postgres",
    pool,
    async init() {
      await pool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
    },
    // Takes the next folio and saves the submission in ONE transaction.
    async createSubmission(s) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const y = YEAR();
        const { rows: [c] } = await client.query(
          `INSERT INTO folio_counters (year, n) VALUES ($1, 1)
           ON CONFLICT (year) DO UPDATE SET n = folio_counters.n + 1 RETURNING n`, [y]);
        const folio = folioOf(y, c.n);
        const { rows: [row] } = await client.query(
          `INSERT INTO submissions (folio, sector, years_in_business, employees, record_years, data_types, record_volume,
             revenue_band, format, frequency, track, estimate_low, estimate_high, estimate_point, tier, score, breakdown, engine_version,
             company_name, owner_name, email, phone, manifest_confirmed, signature_name, signature_method, signature_style, signature_data, signed_at, lang, upload_token_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,now(),$28,$29)
           RETURNING *`,
          [folio, s.sector, s.years_in_business, s.employees, s.record_years, s.data_types, s.record_volume,
           s.revenue_band, s.format, s.frequency, s.track, s.estimate_low, s.estimate_high, s.estimate_point, s.tier, s.score,
           JSON.stringify(s.breakdown), s.engine_version, s.company_name, s.owner_name, s.email || null, s.phone || null,
           true, s.signature_name, s.signature_method || 'typed', s.signature_style || null, s.signature_data || null, s.lang, s.upload_token_hash]);
        await client.query(`INSERT INTO status_history (folio, status) VALUES ($1, 'Nuevo')`, [folio]);
        await client.query("COMMIT");
        return row;
      } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
    },
    async getUploadTokenHash(folio) {
      const { rows } = await pool.query(`SELECT upload_token_hash FROM submissions WHERE folio=$1`, [folio]);
      return rows[0] ? rows[0].upload_token_hash : null;
    },
    async countSamples(folio) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM sample_files WHERE folio=$1`, [folio]);
      return rows[0].n;
    },
    async addSample(folio, f) {
      const { rows: [r] } = await pool.query(
        `INSERT INTO sample_files (folio, stored_name, original_name, size_bytes, mime) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [folio, f.stored_name, f.original_name, f.size_bytes, f.mime]);
      await pool.query(
        `UPDATE submissions SET sample_file_ref = (SELECT string_agg(id::text, ',' ORDER BY id) FROM sample_files WHERE folio=$1),
           status = CASE WHEN status='Nuevo' THEN 'Muestra recibida' ELSE status END WHERE folio=$1`, [folio]);
      return r.id;
    },
    async addFeedback(f) {
      const { rows: [r] } = await pool.query(
        `INSERT INTO feedback (step, folio, comment, lang) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
        [f.step, f.folio, f.comment, f.lang]);
      return r;
    },
    // Live chat: pass session_id=null on the first message of a conversation;
    // a session row is created and its id returned with the message row.
    async addChatMessage(m) {
      let sid = m.session_id;
      if (!sid) {
        const { rows: [s] } = await pool.query(`INSERT INTO chat_sessions (lang, ip) VALUES ($1,$2) RETURNING id`, [m.lang || null, m.ip || null]);
        sid = s.id;
      }
      const { rows: [r] } = await pool.query(
        `INSERT INTO chat_messages (session_id, role, topic, text) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
        [sid, m.role, m.topic || null, m.text]);
      return { ...r, session_id: sid };
    },
    async chatSessionExists(id) {
      const { rows } = await pool.query(`SELECT id FROM chat_sessions WHERE id=$1`, [id]);
      return rows.length > 0;
    },
    async listChats() {
      const { rows } = await pool.query(
        `SELECT s.id, s.created_at, s.lang,
           COALESCE((SELECT json_agg(json_build_object('role',m.role,'topic',m.topic,'text',m.text,'at',m.created_at) ORDER BY m.id)
             FROM chat_messages m WHERE m.session_id=s.id), '[]') AS messages
         FROM chat_sessions s ORDER BY s.created_at DESC LIMIT 500`);
      return rows;
    },
    async addContactMessage(m) {
      const { rows: [r] } = await pool.query(
        `INSERT INTO contact_messages (name, email, message, lang) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
        [m.name || null, m.email, m.message, m.lang || null]);
      return r;
    },
    async listContactMessages() {
      const { rows } = await pool.query(`SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 5000`);
      return rows;
    },
    async listSubmissions() {
      const { rows } = await pool.query(
        `SELECT s.*, COALESCE((SELECT json_agg(json_build_object('id',f.id,'name',f.original_name,'size',f.size_bytes) ORDER BY f.id)
           FROM sample_files f WHERE f.folio=s.folio), '[]') AS samples
         FROM submissions s ORDER BY created_at DESC LIMIT 5000`);
      return rows.map(r => { delete r.upload_token_hash; return r; });
    },
    async listFeedback() {
      const { rows } = await pool.query(`SELECT * FROM feedback ORDER BY created_at DESC LIMIT 5000`);
      return rows;
    },
    async updateStatus(folio, status) {
      const { rowCount } = await pool.query(`UPDATE submissions SET status=$2 WHERE folio=$1`, [folio, status]);
      if (rowCount) await pool.query(`INSERT INTO status_history (folio, status) VALUES ($1,$2)`, [folio, status]);
      return rowCount > 0;
    },
    async getSample(id) {
      const { rows } = await pool.query(`SELECT * FROM sample_files WHERE id=$1`, [id]);
      return rows[0] || null;
    },
    /* ----- owner CRM: staff accounts ----- */
    async listStaff() {
      const { rows } = await pool.query(`SELECT id, email, name, role, active, created_by, created_at FROM staff_users ORDER BY created_at`);
      return rows;
    },
    async getStaffByEmail(email) {
      const { rows } = await pool.query(`SELECT * FROM staff_users WHERE email=$1`, [String(email || "").toLowerCase()]);
      return rows[0] || null;
    },
    async getStaffById(id) {
      const { rows } = await pool.query(`SELECT * FROM staff_users WHERE id=$1`, [id]);
      return rows[0] || null;
    },
    async createStaff(s) {
      const { rows: [r] } = await pool.query(
        `INSERT INTO staff_users (id, email, name, role, password_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, email, name, role, active, created_by, created_at`,
        [s.id, s.email, s.name, s.role, s.password_hash, s.created_by || null]);
      return r;
    },
    async updateStaff(id, p) {
      const sets = [], v = [];
      for (const k of ["name", "role", "active", "password_hash"]) if (p[k] !== undefined) { v.push(p[k]); sets.push(`${k}=$${v.length}`); }
      if (!sets.length) return null;
      v.push(id);
      const { rows: [r] } = await pool.query(`UPDATE staff_users SET ${sets.join(", ")} WHERE id=$${v.length} RETURNING id, email, name, role, active, created_at`, v);
      return r || null;
    },
    /* ----- owner CRM: email outbox (queued until a transport confirms) ----- */
    async addOutbox(m) {
      const { rows: [r] } = await pool.query(
        `INSERT INTO email_outbox (kind, channel, to_email, to_name, subject, body, folio, engagement_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [m.kind, m.channel || "email", m.to_email || null, m.to_name || null, m.subject || null, m.body, m.folio || null, m.engagement_id || null, m.created_by || null]);
      return r;
    },
    async listOutbox(limit = 300) {
      const { rows } = await pool.query(`SELECT * FROM email_outbox ORDER BY id DESC LIMIT $1`, [limit]);
      return rows;
    },
    async getOutbox(id) {
      const { rows } = await pool.query(`SELECT * FROM email_outbox WHERE id=$1`, [id]);
      return rows[0] || null;
    },
    async markOutbox(id, status, note) {
      const { rows: [r] } = await pool.query(
        `UPDATE email_outbox SET status=$2, transport_note=$3, sent_at = CASE WHEN $2='sent' THEN now() ELSE sent_at END WHERE id=$1 RETURNING *`,
        [id, status, note || null]);
      return r || null;
    },
    /* ----- owner CRM: offer board ----- */
    async addOffer(o) {
      const { rows: [r] } = await pool.query(
        `INSERT INTO offers (folio, engagement_id, partner_name, partner_email, amount, currency, terms_note, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [o.folio || null, o.engagement_id || null, o.partner_name, o.partner_email || null, o.amount, o.currency || "USD", o.terms_note || null, o.recorded_by || null]);
      return r;
    },
    async listOffers(f = {}) {
      const w = [], v = [];
      if (f.folio) { v.push(f.folio); w.push(`folio=$${v.length}`); }
      if (f.engagement_id) { v.push(f.engagement_id); w.push(`engagement_id=$${v.length}`); }
      const { rows } = await pool.query(`SELECT * FROM offers ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 1000`, v);
      return rows;
    },
    async decideOffer(id, status, by) {
      const { rows: [r] } = await pool.query(
        `UPDATE offers SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1 AND status='open' RETURNING *`, [id, status, by]);
      return r || null;
    },
    /* ----- owner CRM: partner queue + per-file thread ----- */
    async addPartnerMessage(m) {
      const { rows: [r] } = await pool.query(
        `INSERT INTO partner_messages (engagement_id, folio, direction, channel, author, text) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [m.engagement_id || null, m.folio || null, m.direction, m.channel || "email", m.author || null, m.text]);
      return r;
    },
    async listPartnerMessages(engagementId) {
      const { rows } = engagementId
        ? await pool.query(`SELECT * FROM partner_messages WHERE engagement_id=$1 ORDER BY id`, [engagementId])
        : await pool.query(`SELECT * FROM partner_messages ORDER BY id DESC LIMIT 500`);
      return rows;
    },
    async addFileMessage(m) {
      const { rows: [r] } = await pool.query(
        `INSERT INTO file_messages (folio, direction, kind, author, text) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [m.folio, m.direction, m.kind || "note", m.author || null, m.text]);
      return r;
    },
    async listFileMessages(folio) {
      const { rows } = await pool.query(`SELECT * FROM file_messages WHERE folio=$1 ORDER BY id`, [folio]);
      return rows;
    },
    /* ----- owner CRM: checklist, stuck note, assignment, history ----- */
    async listChecklist(folio) {
      const { rows } = await pool.query(`SELECT * FROM checklist_items WHERE folio=$1 ORDER BY id`, [folio]);
      return rows;
    },
    async addChecklistItem(i) {
      const { rows: [r] } = await pool.query(
        `INSERT INTO checklist_items (folio, source, label, expect, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [i.folio, i.source || "staff", i.label, i.expect || null, i.created_by || null]);
      return r;
    },
    async updateChecklistItem(id, p) {
      const sets = [], v = [];
      for (const k of ["label", "expect", "status", "satisfied_by_file"]) if (p[k] !== undefined) { v.push(p[k]); sets.push(`${k}=$${v.length}`); }
      if (!sets.length) return null;
      if (p.status === "requested") sets.push("requested_at = now()");
      if (p.status === "received") sets.push("received_at = now()");
      sets.push("updated_at = now()");
      v.push(id);
      const { rows: [r] } = await pool.query(`UPDATE checklist_items SET ${sets.join(", ")} WHERE id=$${v.length} RETURNING *`, v);
      return r || null;
    },
    async getFileNote(folio) {
      const { rows } = await pool.query(`SELECT * FROM file_notes WHERE folio=$1`, [folio]);
      return rows[0] || null;
    },
    async setFileNote(folio, n) {
      const { rows: [r] } = await pool.query(
        `INSERT INTO file_notes (folio, reason_category, note, next_action, action_owner, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (folio) DO UPDATE SET reason_category=$2, note=$3, next_action=$4, action_owner=$5, updated_by=$6, updated_at=now()
         RETURNING *`,
        [folio, n.reason_category || null, n.note || null, n.next_action || null, n.action_owner || null, n.updated_by || null]);
      return r;
    },
    async setAssignment(folio, email) {
      const { rowCount } = await pool.query(`UPDATE submissions SET assigned_to=$2 WHERE folio=$1`, [folio, email || null]);
      return rowCount > 0;
    },
    async listStatusHistory(folio) {
      const { rows } = await pool.query(`SELECT status, changed_at FROM status_history WHERE folio=$1 ORDER BY id`, [folio]);
      return rows;
    },
    async close() { await pool.end(); },
  };
}

/* ---------------- JSON file (local testing only) ---------------- */
function jsonFile(dir) {
  const file = path.join(dir, "db.json");
  let chain = Promise.resolve();
  const locked = fn => (chain = chain.then(fn, fn));            // one write at a time
  const load = () => { let d; try { d = JSON.parse(fs.readFileSync(file, "utf8")); } catch { d = {}; }
    return Object.assign({ counters: {}, submissions: [], samples: [], feedback: [], history: [], ids: 0, chatSessions: [], chatMessages: [], contactMessages: [], staffUsers: [], outbox: [], offers: [], partnerMessages: [], fileMessages: [], checklist: [], fileNotes: {} }, d); };
  const save = d => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file + ".tmp", JSON.stringify(d, null, 1)); fs.renameSync(file + ".tmp", file); };
  const strip = s => { const { upload_token_hash, ...r } = s; return r; };

  return {
    kind: "json-file",
    async init() { fs.mkdirSync(dir, { recursive: true }); if (!fs.existsSync(file)) save(load()); },
    createSubmission: s => locked(() => {
      const d = load(), y = YEAR();
      d.counters[y] = (d.counters[y] || 0) + 1;
      const row = { id: ++d.ids, folio: folioOf(y, d.counters[y]), created_at: new Date().toISOString(), ...s,
        manifest_confirmed: true, signed_at: new Date().toISOString(), sample_file_ref: null, status: "Nuevo", assigned_to: null };
      d.submissions.push(row); d.history.push({ folio: row.folio, status: "Nuevo", changed_at: row.created_at });
      save(d); return strip(row);
    }),
    async getUploadTokenHash(folio) { const s = load().submissions.find(x => x.folio === folio); return s ? s.upload_token_hash : null; },
    async countSamples(folio) { return load().samples.filter(x => x.folio === folio).length; },
    addSample: (folio, f) => locked(() => {
      const d = load(), id = ++d.ids;
      d.samples.push({ id, folio, ...f, created_at: new Date().toISOString() });
      const s = d.submissions.find(x => x.folio === folio);
      s.sample_file_ref = d.samples.filter(x => x.folio === folio).map(x => x.id).join(",");
      if (s.status === "Nuevo") s.status = "Muestra recibida";
      save(d); return id;
    }),
    addFeedback: f => locked(() => {
      const d = load(), r = { id: ++d.ids, created_at: new Date().toISOString(), ...f };
      d.feedback.push(r); save(d); return r;
    }),
    async listSubmissions() {
      const d = load();
      return d.submissions.slice().reverse().map(s => ({ ...strip(s),
        samples: d.samples.filter(x => x.folio === s.folio).map(x => ({ id: x.id, name: x.original_name, size: x.size_bytes })) }));
    },
    async listFeedback() { return load().feedback.slice().reverse(); },
    addChatMessage: m => locked(() => {
      const d = load();
      let sid = m.session_id;
      if (!sid || !d.chatSessions.some(s => s.id === sid)) {
        sid = ++d.ids;
        d.chatSessions.push({ id: sid, created_at: new Date().toISOString(), lang: m.lang || null, ip: m.ip || null });
      }
      const r = { id: ++d.ids, session_id: sid, created_at: new Date().toISOString(), role: m.role, topic: m.topic || null, text: m.text };
      d.chatMessages.push(r); save(d); return r;
    }),
    async chatSessionExists(id) { return load().chatSessions.some(s => s.id === Number(id)); },
    async listChats() {
      const d = load();
      return d.chatSessions.slice().reverse().map(s => ({ ...s,
        messages: d.chatMessages.filter(m => m.session_id === s.id).map(m => ({ role: m.role, topic: m.topic, text: m.text, at: m.created_at })) }));
    },
    addContactMessage: m => locked(() => {
      const d = load(), r = { id: ++d.ids, created_at: new Date().toISOString(), name: m.name || null, email: m.email, message: m.message, lang: m.lang || null };
      d.contactMessages.push(r); save(d); return r;
    }),
    async listContactMessages() { return load().contactMessages.slice().reverse(); },
    updateStatus: (folio, status) => locked(() => {
      const d = load(), s = d.submissions.find(x => x.folio === folio);
      if (!s) return false;
      s.status = status; d.history.push({ folio, status, changed_at: new Date().toISOString() }); save(d); return true;
    }),
    async getSample(id) { return load().samples.find(x => x.id === Number(id)) || null; },
    /* ----- owner CRM (JSON-file mirrors of the Postgres methods) ----- */
    async listStaff() { return load().staffUsers.map(({ password_hash, ...u }) => u); },
    async getStaffByEmail(email) { return load().staffUsers.find(u => u.email === String(email || "").toLowerCase()) || null; },
    async getStaffById(id) { return load().staffUsers.find(u => u.id === id) || null; },
    createStaff: s => locked(() => {
      const d = load();
      const r = { id: s.id, email: s.email, name: s.name, role: s.role, password_hash: s.password_hash, active: true, created_by: s.created_by || null, created_at: new Date().toISOString() };
      d.staffUsers.push(r); save(d);
      const { password_hash, ...pub } = r; return pub;
    }),
    updateStaff: (id, p) => locked(() => {
      const d = load(), u = d.staffUsers.find(x => x.id === id);
      if (!u) return null;
      for (const k of ["name", "role", "active", "password_hash"]) if (p[k] !== undefined) u[k] = p[k];
      save(d);
      const { password_hash, ...pub } = u; return pub;
    }),
    addOutbox: m => locked(() => {
      const d = load(), r = { id: ++d.ids, created_at: new Date().toISOString(), status: "queued", transport_note: null, sent_at: null,
        kind: m.kind, channel: m.channel || "email", to_email: m.to_email || null, to_name: m.to_name || null, subject: m.subject || null,
        body: m.body, folio: m.folio || null, engagement_id: m.engagement_id || null, created_by: m.created_by || null };
      d.outbox.push(r); save(d); return r;
    }),
    async listOutbox(limit = 300) { return load().outbox.slice().reverse().slice(0, limit); },
    async getOutbox(id) { return load().outbox.find(x => x.id === Number(id)) || null; },
    markOutbox: (id, status, note) => locked(() => {
      const d = load(), r = d.outbox.find(x => x.id === Number(id));
      if (!r) return null;
      r.status = status; r.transport_note = note || null; if (status === "sent") r.sent_at = new Date().toISOString();
      save(d); return r;
    }),
    addOffer: o => locked(() => {
      const d = load(), r = { id: ++d.ids, created_at: new Date().toISOString(), status: "open", decided_by: null, decided_at: null,
        folio: o.folio || null, engagement_id: o.engagement_id || null, partner_name: o.partner_name, partner_email: o.partner_email || null,
        amount: o.amount, currency: o.currency || "USD", terms_note: o.terms_note || null, recorded_by: o.recorded_by || null };
      d.offers.push(r); save(d); return r;
    }),
    async listOffers(f = {}) {
      return load().offers.filter(o => (!f.folio || o.folio === f.folio) && (!f.engagement_id || o.engagement_id === f.engagement_id)).slice().reverse();
    },
    decideOffer: (id, status, by) => locked(() => {
      const d = load(), r = d.offers.find(x => x.id === Number(id));
      if (!r || r.status !== "open") return null;
      r.status = status; r.decided_by = by; r.decided_at = new Date().toISOString(); save(d); return r;
    }),
    addPartnerMessage: m => locked(() => {
      const d = load(), r = { id: ++d.ids, created_at: new Date().toISOString(), engagement_id: m.engagement_id || null, folio: m.folio || null,
        direction: m.direction, channel: m.channel || "email", author: m.author || null, text: m.text };
      d.partnerMessages.push(r); save(d); return r;
    }),
    async listPartnerMessages(engagementId) {
      const all = load().partnerMessages;
      return engagementId ? all.filter(m => m.engagement_id === engagementId) : all.slice().reverse().slice(0, 500);
    },
    addFileMessage: m => locked(() => {
      const d = load(), r = { id: ++d.ids, created_at: new Date().toISOString(), folio: m.folio, direction: m.direction, kind: m.kind || "note", author: m.author || null, text: m.text };
      d.fileMessages.push(r); save(d); return r;
    }),
    async listFileMessages(folio) { return load().fileMessages.filter(m => m.folio === folio); },
    async listChecklist(folio) { return load().checklist.filter(i => i.folio === folio); },
    addChecklistItem: i => locked(() => {
      const d = load(), now = new Date().toISOString();
      const r = { id: ++d.ids, created_at: now, updated_at: now, status: "missing", satisfied_by_file: null, requested_at: null, received_at: null,
        folio: i.folio, source: i.source || "staff", label: i.label, expect: i.expect || null, created_by: i.created_by || null };
      d.checklist.push(r); save(d); return r;
    }),
    updateChecklistItem: (id, p) => locked(() => {
      const d = load(), r = d.checklist.find(x => x.id === Number(id));
      if (!r) return null;
      for (const k of ["label", "expect", "status", "satisfied_by_file"]) if (p[k] !== undefined) r[k] = p[k];
      if (p.status === "requested") r.requested_at = new Date().toISOString();
      if (p.status === "received") r.received_at = new Date().toISOString();
      r.updated_at = new Date().toISOString(); save(d); return r;
    }),
    async getFileNote(folio) { return load().fileNotes[folio] || null; },
    setFileNote: (folio, n) => locked(() => {
      const d = load();
      const r = { folio, reason_category: n.reason_category || null, note: n.note || null, next_action: n.next_action || null,
        action_owner: n.action_owner || null, updated_by: n.updated_by || null, updated_at: new Date().toISOString() };
      d.fileNotes[folio] = r; save(d); return r;
    }),
    setAssignment: (folio, email) => locked(() => {
      const d = load(), s = d.submissions.find(x => x.folio === folio);
      if (!s) return false;
      s.assigned_to = email || null; save(d); return true;
    }),
    async listStatusHistory(folio) { return load().history.filter(h => h.folio === folio).map(h => ({ status: h.status, changed_at: h.changed_at })); },
    async close() {},
  };
}

module.exports = process.env.DATABASE_URL
  ? postgres(process.env.DATABASE_URL)
  : jsonFile(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
