// ============================================================
// Zoom handoff for appointment bookings (Nov 25 2026).
//
// Miguel's direction: when a seller books, the appointment goes DIRECTLY
// into a Zoom meeting on HIS account, inviting Gil Concepcion, Tyler
// Kruse and Miguel, with cloud auto-recording + transcript on.
//
// The Render web server cannot use the Muse-side Zoom connector (that
// lives in Muse's environment, not the app's). The app-side route is a
// Zoom Server-to-Server OAuth app on Miguel's account. Until these env
// vars are set on the server, configured() is false and NOTHING here
// creates or fakes a meeting: the panel's one-click "Create Zoom" then
// only records the intent (booking.zoom_status = 'queued') with the
// invitee list attached, ready for the moment the credentials land.
//
//   ZOOM_ACCOUNT_ID     Zoom account id (S2S OAuth app)
//   ZOOM_CLIENT_ID      S2S OAuth client id
//   ZOOM_CLIENT_SECRET  S2S OAuth client secret
//   ZOOM_HOST           host user id or email on Miguel's account
//                       (default: migueladplus@gmail.com)
//
// TRANSCRIPT: Zoom has no per-meeting transcript switch in the create
// API — transcripts come from the account's cloud-recording setting
// "Create audio transcript". That toggle must be ON in Miguel's Zoom
// account settings (one-time, account level) for transcripts to exist.
// This module always sets auto_recording: "cloud" at creation, per the
// standing rule, and the created meeting is read back by the caller to
// verify the recording setting stuck.
// ============================================================
const opt = require("./options");

const configured = () => !!(process.env.ZOOM_ACCOUNT_ID && process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET);
const host = () => process.env.ZOOM_HOST || "migueladplus@gmail.com";

// Window → concrete start (ET) for the created meeting.
function slotStart(booking) {
  return { start_time: `${booking.appt_date}T${opt.BOOKING_WINDOW_START[booking.window] || "10:00:00"}`, timezone: opt.BOOKING_TZ, duration: 30 };
}

function meetingPayload(booking) {
  const p = booking.profile || {};
  const when = slotStart(booking);
  return {
    topic: `DATA Patrimonio — cita con ${booking.name}`,
    type: 2, // scheduled
    start_time: when.start_time,
    timezone: when.timezone,
    duration: when.duration,
    agenda: [
      "Cita de valoración DATA Patrimonio.",
      `Vendedor: ${booking.name} <${booking.email}>${booking.phone ? " · WhatsApp " + booking.phone : ""}`,
      `Estimado preliminar: $${Number(p.estimate_low || 0).toLocaleString("en-US")} – $${Number(p.estimate_high || 0).toLocaleString("en-US")} (${p.tier || "—"}, ${p.score ?? "—"}/100)`,
      `Modalidad: ${p.track || "compra_directa"}`,
      booking.note ? `Nota del vendedor: ${booking.note}` : "",
      `Invitados: ${opt.ZOOM_INVITEES.join(", ")}`,
    ].filter(Boolean).join("\n"),
    settings: {
      host_video: false,
      participant_video: false,
      join_before_host: false,
      waiting_room: true,
      auto_recording: "cloud",           // standing rule: cloud auto-recording ON at creation
      // transcript: account-level "Create audio transcript" cloud-recording
      // setting (see header) — no per-meeting switch exists in the API.
    },
  };
}

async function accessToken() {
  const basic = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString("base64");
  const r = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(process.env.ZOOM_ACCOUNT_ID)}`, {
    method: "POST", headers: { Authorization: `Basic ${basic}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("zoom oauth failed: " + (j.error_description || j.error || r.status));
  return j.access_token;
}

// Creates the meeting and reads it back to verify recording is on.
// Returns { meeting_id, join_url, start_url, recording_on }.
async function createMeetingForBooking(booking) {
  if (!configured()) throw Object.assign(new Error("zoom not configured"), { code: "not_configured" });
  const token = await accessToken();
  const r = await fetch(`https://api.zoom.us/v2/users/${encodeURIComponent(host())}/meetings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(meetingPayload(booking)),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error("zoom create failed: " + (j.message || r.status));
  // Read back: a meeting only counts as recorded if the setting stuck.
  let recordingOn = null;
  try {
    const g = await fetch(`https://api.zoom.us/v2/meetings/${j.id}`, { headers: { Authorization: `Bearer ${token}` } });
    const gj = await g.json().catch(() => ({}));
    recordingOn = gj.settings ? gj.settings.auto_recording === "cloud" : null;
  } catch (e) { recordingOn = null; }
  return { meeting_id: String(j.id), join_url: j.join_url || null, start_url: j.start_url || null, recording_on: recordingOn };
}

module.exports = { configured, host, slotStart, meetingPayload, createMeetingForBooking, INVITEES: opt.ZOOM_INVITEES };
