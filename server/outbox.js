// ============================================================
// Email outbox. EVERY outbound message is written to email_outbox
// first. Delivery transports, in order:
//   1. SMTP (Gmail / Google Workspace) — configured by SMTP_USER +
//      SMTP_APP_PASSWORD (an App Password on the hola@ account),
//      optional SMTP_HOST (default smtp.gmail.com) and SMTP_PORT
//      (default 465 = implicit TLS; 587 = STARTTLS). Zero-dependency
//      implementation (node:net / node:tls) on purpose: the Render
//      build runs `npm ci`, so package.json/package-lock must stay
//      untouched for a transport change.
//   2. OUTBOX_WEBHOOK_URL — a Slack/Zapier/Make hook or small mail
//      relay that accepts {from,to,subject,body,...} JSON (fallback).
// Until a transport is configured, rows stay 'queued' and the panel
// shows them as queued: a message is NEVER marked sent without a
// transport confirmation.
// WhatsApp rows are queued for the WhatsApp Web workflow (a person or
// the support agent sends them from the browser) and likewise stay
// 'queued' until someone marks the send after it really went out.
// ============================================================

const net = require("net");
const tls = require("tls");

const FROM = () => process.env.OUTBOX_FROM || "hola@dataismoney.ai";   // company mailbox on the owned domain (Miguel's decision, Nov 24, 2026 — short address, replaces the planned datospatrimonio@gmail.com)

function smtpConfig() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_APP_PASSWORD;
  if (!user || !pass) return null;
  const port = Number(process.env.SMTP_PORT || 465);
  return {
    user,
    pass,
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port,
    // Implicit TLS on 465 by default; SMTP_SECURE=false is a dev-only
    // escape hatch (e.g. a local stub server) and never set in prod.
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
  };
}

function transportStatus() {
  if (smtpConfig()) return "smtp";
  if (process.env.OUTBOX_WEBHOOK_URL) return "webhook";
  return "none";
}

/* ---------- minimal SMTP client (RFC 5321 + STARTTLS + AUTH LOGIN) ---------- */

// Buffered line reader + reply parser over a net/tls socket. An SMTP
// reply is complete when a line reads "NNN " (code + space); "NNN-"
// lines are continuations of a multi-line reply.
function makeChannel(sock) {
  let buf = "";
  const lines = [];
  const waiters = [];
  function pump() {
    while (waiters.length && lines.length) waiters.shift()(lines.shift());
  }
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\r\n")) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
    pump();
  });
  const nextLine = () => new Promise((res) => { waiters.push(res); pump(); });
  async function readReply() {
    const got = [];
    for (;;) {
      const line = await nextLine();
      got.push(line);
      const m = /^(\d{3})([ -])/.exec(line) || /^(\d{3})$/.exec(line);
      if (m && m[2] !== "-") return { code: Number(m[1]), lines: got };
      if (!m && got.length > 20) throw new Error("unparseable SMTP reply: " + line);
    }
  }
  return { readReply, write: (s) => sock.write(s) };
}

async function expect(ch, codes, what) {
  const r = await ch.readReply();
  if (!codes.includes(r.code)) {
    throw new Error(`SMTP ${what} refused (${r.code} ${r.lines.join(" / ")})`);
  }
  return r;
}

function encodeHeaderValue(v) {
  const s = String(v == null ? "" : v);
  // RFC 2047 encoded-word when the value leaves printable ASCII.
  if (/[^\x20-\x7e]/.test(s)) return "=?UTF-8?B?" + Buffer.from(s, "utf8").toString("base64") + "?=";
  return s;
}

function buildMessage(row, from) {
  const to = row.to_name ? `${encodeHeaderValue(row.to_name)} <${row.to_email}>` : row.to_email;
  const bodyB64 = Buffer.from(String(row.body || ""), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return [
    `Date: ${new Date().toUTCString()}`,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(row.subject || "")}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    bodyB64,
  ].join("\r\n");
}

async function sendViaSmtp(cfg, row) {
  const from = FROM();
  const sock = cfg.secure
    ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
    : net.connect({ host: cfg.host, port: cfg.port });
  sock.setTimeout(30000);
  try {
    await new Promise((res, rej) => {
      if (cfg.secure) sock.once("secureConnect", res);
      else sock.once("connect", res);
      sock.once("error", rej);
      sock.once("timeout", () => rej(new Error("SMTP connection timed out")));
    });
    let ch = makeChannel(sock);
    await expect(ch, [220], "greeting");
    const ehlo = async () => {
      ch.write(`EHLO ${cfg.host}\r\n`);
      return expect(ch, [250], "EHLO");
    };
    await ehlo();
    if (!cfg.secure && cfg.port === 587) {
      ch.write("STARTTLS\r\n");
      await expect(ch, [220], "STARTTLS");
      const upgraded = tls.connect({ socket: sock, servername: cfg.host });
      await new Promise((res, rej) => {
        upgraded.once("secureConnect", res);
        upgraded.once("error", rej);
      });
      ch = makeChannel(upgraded);
      await ehlo();
      return await finishSmtp(ch, cfg, row, from, upgraded);
    }
    return await finishSmtp(ch, cfg, row, from, sock);
  } finally {
    try { sock.destroy(); } catch (_) { /* already gone */ }
  }
}

async function finishSmtp(ch, cfg, row, from, sock) {
  const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64");
  ch.write("AUTH LOGIN\r\n");
  await expect(ch, [334], "AUTH LOGIN");
  ch.write(b64(cfg.user) + "\r\n");
  await expect(ch, [334], "AUTH username");
  ch.write(b64(cfg.pass) + "\r\n");
  await expect(ch, [235], "AUTH password");
  ch.write(`MAIL FROM:<${from}>\r\n`);
  await expect(ch, [250], "MAIL FROM");
  ch.write(`RCPT TO:<${row.to_email}>\r\n`);
  await expect(ch, [250, 251], "RCPT TO");
  ch.write("DATA\r\n");
  await expect(ch, [354], "DATA");
  // Dot-stuffing is unnecessary: the body is base64, no line starts with '.'.
  ch.write(buildMessage(row, from) + "\r\n.\r\n");
  const done = await expect(ch, [250], "message body");
  try { ch.write("QUIT\r\n"); } catch (_) { /* reply not needed */ }
  try { sock.end(); } catch (_) { /* ignore */ }
  return done.lines.join(" ");
}

/* ---------- delivery ---------- */

async function attempt(db, row) {
  if (row.status === "sent") return row;
  if (row.channel === "whatsapp") {
    return db.markOutbox(row.id, "queued", "WhatsApp Web: send from the browser, then mark sent") || row;
  }

  const cfg = smtpConfig();
  if (cfg) {
    try {
      const info = await sendViaSmtp(cfg, row);
      return db.markOutbox(row.id, "sent", `SMTP accepted (${cfg.host}): ${String(info).slice(0, 120)}`) || row;
    } catch (e) {
      if (!process.env.OUTBOX_WEBHOOK_URL) {
        return db.markOutbox(row.id, "failed", "SMTP error: " + e.message) || row;
      }
      // Fall through to the webhook relay as the backup transport.
      const wh = await attemptWebhook(db, row);
      if (wh && wh.status === "sent") return wh;
      return db.markOutbox(row.id, "failed", "SMTP error: " + e.message + "; webhook fallback also failed") || row;
    }
  }
  return attemptWebhook(db, row);
}

async function attemptWebhook(db, row) {
  const url = process.env.OUTBOX_WEBHOOK_URL;
  if (!url) return db.markOutbox(row.id, "queued", "no transport configured (set SMTP_USER + SMTP_APP_PASSWORD, or OUTBOX_WEBHOOK_URL)") || row;
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

module.exports = { queue, attempt, FROM, transportStatus };
