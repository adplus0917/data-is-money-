// ============================================================
// Email outbox. EVERY outbound message is written to email_outbox
// first. Delivery goes through OUTBOX_WEBHOOK_URL (a Slack/Zapier/Make
// hook or a small mail relay that accepts {from,to,subject,body,...}
// JSON) — the hook is where the dedicated DATA Patrimonio Gmail gets
// wired in once the account exists. Until a transport is configured,
// rows stay 'queued' and the panel shows them as queued: a message is
// NEVER marked sent without a transport confirmation.
// WhatsApp rows are queued for the WhatsApp Web workflow (a person or
// the support agent sends them from the browser) and likewise stay
// 'queued' until someone marks the send after it really went out.
// ============================================================

const FROM = () => process.env.OUTBOX_FROM || "hola@dataismoney.ai";   // company mailbox on the owned domain (Miguel's decision, Nov 24, 2026 — short address, replaces the planned datospatrimonio@gmail.com)

async function attempt(db, row) {
  if (row.status === "sent") return row;
  if (row.channel === "whatsapp") {
    return db.markOutbox(row.id, "queued", "WhatsApp Web: send from the browser, then mark sent") || row;
  }
  const url = process.env.OUTBOX_WEBHOOK_URL;
  if (!url) return db.markOutbox(row.id, "queued", "no transport configured (OUTBOX_WEBHOOK_URL not set)") || row;
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM(), to: row.to_email, to_name: row.to_name, subject: row.subject, body: row.body, kind: row.kind, folio: row.folio, engagement_id: row.engagement_id }),
    });
    if (r.ok) return db.markOutbox(row.id, "sent", `transport accepted (${r.status})`) || row;
    return db.markOutbox(row.id, "failed", `transport refused (${r.status})`) || row;
  } catch (e) {
    return db.markOutbox(row.id, "failed", "transport error: " + e.message) || row;
  }
}

// Write the row, then try to deliver it. Returns the row with its true status.
async function queue(db, msg) {
  const row = await db.addOutbox(msg);
  return attempt(db, row);
}

module.exports = { queue, attempt, FROM };
