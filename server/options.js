// Allowed answer codes. The server rejects anything not in these lists,
// so a tampered browser can't send made-up values into the database.
const { CONFIG } = require("./engine");

const SECTORS = ["gc","stucco","paint","roof","elec","plumb","hvac","remodel","realestate","mfg","transport","health","legal","accounting","restaurant","retail","services","tech","agri","other"];
const YEARS = Object.keys(CONFIG.recordYearsFactor);          // under3, 3to5, 5to10, over10
const EMPLOYEES = Object.keys(CONFIG.employeesFactor);
const TYPES = Object.keys(CONFIG.dataTypeWeight);
const VOLUMES = ["under1k","1kto10k","10kto50k","over50k"];
const REVENUE = Object.keys(CONFIG.revenueBase);
const FORMATS = Object.keys(CONFIG.formatFactor);
const FREQUENCY = Object.keys(CONFIG.frequencyFactor);
const TRACKS = ["compra_directa"];   // single deal path (Nov 25 2026): exclusive direct purchase only — no license track
const STATUSES = ["Nuevo","Contactado","Papel enviado","Firmado","Muestra recibida","Verificado","Pagado","En el vault"];
const MANIFEST_ITEMS = 5;

/* ---------------------------------------------------------------------------
   QUALIFIER QUESTIONNAIRE (Nov 26 2026, Miguel's direct order — "just get
   it done now"): mirrors the competitor intake Miguel walked on Facebook
   (profession reel → tap → qualifier form → CRM → Zoom). The five answers
   ride on the funnel lead (price gate) and on the booking, and land in the
   leads table so the calling team (Panama; Gil/Tyler sales-lane admins)
   can work them. Codes are stored; EN/ES labels live in public/i18n.js.
   --------------------------------------------------------------------------- */
const INDUSTRIES = ["construction_trades","accounting","legal","realestate","tech_software","finance_banking","insurance","professional_services","marketing_media","healthcare","manufacturing","other"];
const AUTHORITY = ["can_approve","partner_signoff"];       // "Can you approve data-sharing decisions for your company?"
const EMPLOYEE_BANDS = ["under20","20to50","51to150","151to500","over500"];
const YEARS_BANDS = ["y0to3","y4to6","y7to10","y11to14","y15plus"];
const POSITIONS = ["founder","owner","president","ceo","board","csuite","other"];
const LEAD_STATUSES = ["new","called","booked","not_interested"];
const LEAD_SOURCES = ["site_gate","meta_instant_form","manual"];

// Returns { ok:true, qualifiers } or { ok:false, error }.
// required=true (the site gate): all five must be answered with valid codes.
// required=false (Meta instant-form intake): valid codes are kept, anything
// missing or unknown becomes null — an ad lead is never dropped over a
// qualifier, but a made-up value is never stored either.
function checkQualifiers(q, required = true) {
  q = q && typeof q === "object" ? q : {};
  const pick = (k, list) => (list.includes(q[k]) ? q[k] : null);
  const out = {
    industry: pick("industry", INDUSTRIES),
    data_authority: pick("data_authority", AUTHORITY),
    employee_band: pick("employee_band", EMPLOYEE_BANDS),
    years_band: pick("years_band", YEARS_BANDS),
    position: pick("position", POSITIONS),
  };
  if (required) {
    const missing = Object.entries(out).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) return { ok: false, error: "invalid or missing qualifier: " + missing.join(", ") };
  }
  return { ok: true, qualifiers: out };
}

// The funnel lead (price gate) and the Meta instant-form intake share this
// shape. Returns { ok:true, lead } or { ok:false, error, error_code? }.
function checkLead(b, { requireQualifiers = true } = {}) {
  if (!b || typeof b !== "object") return { ok: false, error: "missing lead" };
  const name = str(b.name || b.full_name);
  const company_name = str(b.company_name || b.company);
  const email = str(b.email || b.email_address, 200);
  const phone = str(b.phone || b.phone_number, 40);
  const website = str(b.website, 300);
  if (!name) return { ok: false, error: "name is required" };
  if (!company_name) return { ok: false, error: "company name is required" };
  const err = emailError(email);
  if (err === "tld") return { ok: false, error_code: "email_tld", error: "That email ending is not a real domain — for example, .jet is not valid. Did you mean .com? Check the ending (.com, .net, .org…)" };
  if (err) return { ok: false, error_code: "email_format", error: "That email is not in a valid format. It should look like name@company.com, with no spaces." };
  const q = checkQualifiers(b.qualifiers && typeof b.qualifiers === "object" ? b.qualifiers : b, requireQualifiers);
  if (!q.ok) return { ok: false, error: q.error };
  return { ok: true, lead: { name, company_name, email, phone: phone || null, website: website || null, ...q.qualifiers } };
}


/* ---------------------------------------------------------------------------
   LEAD SCORE 1-10 (Nov 27 2026, Miguel's direct order): every lead that
   lands in the CRM carries a 1-10 score so the calling team works the
   best companies first (10s, then 9s, ...) and follow-up teams can be
   built around the tiers. Computed server-side at lead creation from
   the five qualifier answers - the structured data a lead carries:
     employee band - weighted MOST ("most employees" is the top signal):
       under20 0 / 20to50 1 / 51to150 2 / 151to500 3 / over500 4
     years in operation (more years = more accumulated data):
       y0to3 0 / y4to6 0.5 / y7to10 1 / y11to14 1.5 / y15plus 2
     industry (richness of the data for AI training):
       1.5 tech_software, finance_banking, healthcare, insurance
       1.0 legal, accounting, professional_services, realestate,
           marketing_media, manufacturing
       0.5 construction_trades, other
     position (a decision-maker answered):
       founder/owner/president/ceo/csuite/board 1 / other 0.25
     data-sharing authority: can_approve 0.5 / partner_signoff 0
   Raw points max at 9 and scale onto 1-10 (score = round(raw * 10/9),
   clamped 1-10), so only the full top combination earns a 10. CAP: a
   lead whose contact CANNOT approve data sharing (partner_signoff, or
   the question unanswered) is capped at 7 - never a top tier until
   that changes. Missing answers score 0 for their factor. The weights
   live ONLY here; adjust them in this one place and every new lead
   follows. (The valuation estimate joins later, on the booking record,
   which carries its own engine score - it is not part of this score.)
   --------------------------------------------------------------------------- */
const LEAD_SCORE_POINTS = {
  employee_band: { under20: 0, "20to50": 1, "51to150": 2, "151to500": 3, over500: 4 },
  years_band: { y0to3: 0, y4to6: 0.5, y7to10: 1, y11to14: 1.5, y15plus: 2 },
  industry: { tech_software: 1.5, finance_banking: 1.5, healthcare: 1.5, insurance: 1.5, legal: 1, accounting: 1, professional_services: 1, realestate: 1, marketing_media: 1, manufacturing: 1, construction_trades: 0.5, other: 0.5 },
  position: { founder: 1, owner: 1, president: 1, ceo: 1, csuite: 1, board: 1, other: 0.25 },
  data_authority: { can_approve: 0.5, partner_signoff: 0 },
};
function scoreLead(q) {
  q = q && typeof q === "object" ? q : {};
  let raw = 0;
  for (const k of Object.keys(LEAD_SCORE_POINTS)) raw += LEAD_SCORE_POINTS[k][q[k]] || 0;
  let score = Math.min(10, Math.max(1, Math.round(raw * 10 / 9)));
  if (q.data_authority !== "can_approve") score = Math.min(score, 7);
  return score;
}

const str = (v, max = 160) => typeof v === "string" ? v.trim().slice(0, max) : "";

// ---------------------------------------------------------------------------
// MERGE FIX (.jet email bug) — ported from the live DATA Patrimonio site
// (server actions emailError). Strict email validation: format AND a real
// top-level domain. A typo like ".jet" instead of ".com" (caught by Miguel,
// Nov 24 2026) passes a plain regex because ".jet" looks like a syntactically
// valid TLD; it is not a real IANA TLD. Rule: 2-letter TLDs are country
// codes (accepted); 3+ letter TLDs must be in the known-TLD set below.
// Returns "format" | "tld" | null.
// ---------------------------------------------------------------------------
const KNOWN_TLDS = new Set(
  "com net org edu gov mil int info biz name pro aero coop museum mobi travel jobs asia tel post xxx cat geo academy agency app art audio auto autos baby band bar bargains baseball basketball beauty beer best bid bike bingo bio black blog blue boo book boutique builders business buzz cab cafe camera camp capital cards care career careers cars casa cash casino catering center ceo chat cheap church city claims cleaning clinic clothing cloud club coach codes coffee college community company computer condos construction consulting contact contractors cooking cool country coupons courses credit cricket cruises dance date dating deals degree delivery democrat dental dentist design dev diamonds diet digital direct directory discount doctor dog domains download earth education email energy engineer engineering enterprises equipment estate events exchange expert exposed express fail faith family fans farm fashion feedback finance financial fish fishing fit fitness flights florist flowers fly football forsale forum foundation fun fund furniture futbol fyi gallery game games garden gay gifts gives glass global gmbh gold golf graphics gratis green gripe group guide guitars guru hair haus health healthcare help hiphop hockey holdings holiday homes horse hospital host hosting house how icu immo immobilien inc industries ink institute insure international investments jewelry kitchen land lawyer lease legal lgbt life lighting limited limo live living llc loan loans lol love ltd luxe luxury maison management market marketing markets mba media memorial men menu moda moe mom money mortgage motorcycles movie nagoya navy network news ninja now observer okinawa one online organic page partners parts party pet pharmacy photo photography photos physio pics pictures pink pizza place plumbing plus poker porn press productions promo properties property protection pub qpon quebec racing radio realty recipes red rehab reisen rentals repair report republican restaurant restaurants review reviews rip rocks rodeo rugby run sale salon sarl school schule science security select services sex sexy shoes shopping show singles site ski soccer social software solar solutions soy space storage store stream studio study style sucks supplies supply support surf surgery systems tattoo tax taxi team tech technology tennis theater theatre tickets tienda tips tires today tokyo tools top tours town toys trade training tube university uno vacations vegas ventures vet video villas vin vip vision vodka vote voting voto voyage watch webcam website wedding wiki win wine work works world wow xyz yoga yokohama zone lat rio usa".split(" "),
);
function emailError(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || e.length > 254 || /\s/.test(e)) return "format";
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.exec(e)) return "format";
  const [local, domain] = e.split("@");
  if (!local || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return "format";
  if (!domain || domain.includes("..")) return "format";
  const labels = domain.split(".");
  if (labels.some(l => !l || l.startsWith("-") || l.endsWith("-"))) return "format";
  const tld = labels[labels.length - 1] || "";
  if (tld.length === 2) return null; // country-code TLD
  if (!KNOWN_TLDS.has(tld)) return "tld";
  return null;
}
const isValidEmail = email => emailError(email) === null;

// Returns { ok:true, answers } or { ok:false, error }
function checkAnswers(a) {
  if (!a || typeof a !== "object") return { ok: false, error: "missing answers" };
  const pick = (k, list) => (list.includes(a[k]) ? a[k] : null);
  const out = {
    sector: pick("sector", SECTORS),
    years_in_business: pick("years_in_business", YEARS),
    employees: pick("employees", EMPLOYEES),
    record_years: pick("record_years", YEARS),
    record_volume: pick("record_volume", VOLUMES),
    revenue_band: pick("revenue_band", REVENUE),
    format: pick("format", FORMATS),
    frequency: pick("frequency", FREQUENCY),
    track: pick("track", TRACKS),
    data_types: Array.isArray(a.data_types) ? [...new Set(a.data_types.filter(t => TYPES.includes(t)))] : [],
  };
  const missing = Object.entries(out).filter(([k, v]) => (k === "data_types" ? v.length === 0 : !v)).map(([k]) => k);
  if (missing.length) return { ok: false, error: "invalid or missing: " + missing.join(", ") };
  return { ok: true, answers: out };
}

function checkContact(c) {
  const out = {
    company_name: str(c && c.company_name),
    owner_name: str(c && c.owner_name),
    email: str(c && c.email, 200),
    phone: str(c && c.phone, 40),
    signature_name: str(c && c.signature_name, 120),
    // MERGE FIX (signature window): how the signature was made in the modal.
    signature_method: ["typed", "drawn"].includes(c && c.signature_method) ? c.signature_method : "typed",
    signature_style: str(c && c.signature_style, 40),
    signature_data: typeof (c && c.signature_data) === "string" ? c.signature_data : "",
  };
  if (!out.company_name || !out.owner_name) return { ok: false, error: "company and owner are required" };
  if (!out.email && !out.phone) return { ok: false, error: "email or phone is required" };
  if (out.email) {
    const err = emailError(out.email);
    if (err === "tld") return { ok: false, error_code: "email_tld", error: "That email ending is not a real domain — for example, .jet is not valid. Did you mean .com? Check the ending (.com, .net, .org…)" };
    if (err) return { ok: false, error_code: "email_format", error: "That email is not in a valid format. It should look like name@company.com, with no spaces." };
  }
  if (out.signature_name.length < 3) return { ok: false, error: "signature is required — open the signature window and choose or draw your signature" };
  if (out.signature_method === "drawn") {
    if (!/^data:image\/png;base64,/.test(out.signature_data) || out.signature_data.length < 200 || out.signature_data.length > 900000)
      return { ok: false, error: "drawn signature is missing — draw your signature in the signature window" };
  } else {
    if (out.signature_name.toLowerCase() !== out.owner_name.toLowerCase())
      return { ok: false, error: "The typed signature must match the representative's name" };
    out.signature_data = "";
  }
  return { ok: true, contact: out };
}

const toEngineInput = a => ({ revenueBand: a.revenue_band, recordYears: a.record_years, employees: a.employees, dataTypes: a.data_types, format: a.format, frequency: a.frequency });

/* ---------------------------------------------------------------------------
   APPOINTMENT BOOKING (Nov 25 2026, Miguel's direction): campaign ads land
   on the screening funnel; after the valuation the seller books a call.
   SINGLE-SLOT AVAILABILITY (Nov 26 2026, Miguel's decision — supersedes
   the same-day every-day/two-window setup): ONE daily Zoom slot, 2:00 PM
   America/New_York, Monday–Friday only, 30 minutes. The offered list is
   the next BOOKING_DAYS business days starting tomorrow ET (default 10).
   The slot keeps the internal window code "afternoon" — its Zoom start
   (BOOKING_WINDOW_START.afternoon = 14:00:00 ET) and the bookings table
   CHECK constraint already use it, so the stored shape is unchanged.
   BOOKING_EVERY_DAY=true is an env escape hatch (NOT set in render.yaml)
   that would offer weekends again.
   The client renders the same list with the same algorithm (public/app.js
   bookingDaysClient); the server re-derives it here and rejects anything
   else, so a tampered browser can't book a date three months out.
   --------------------------------------------------------------------------- */
const BOOKING_WINDOWS = ["afternoon"];
const BOOKING_SLOT = { window: "afternoon", time: "14:00", label: "2:00 PM", tz: "America/New_York", duration_min: 30, meeting_type: "zoom" };
const BOOKING_STATUSES = ["pending", "confirmed", "done"];
const BOOKING_DAYS = Math.max(1, Math.min(14, parseInt(process.env.BOOKING_DAYS || "10", 10) || 10));
const BOOKING_EVERY_DAY = process.env.BOOKING_EVERY_DAY === "true";
const BOOKING_TZ = "America/New_York";
// The Zoom meeting for a booking is on Miguel's account; these are the
// people who get the invite (Miguel's direction, Nov 25 2026).
const ZOOM_INVITEES = ["gconcepcion@cpointehomes.com", "tkruse@cpointehomes.com", "migueladplus@gmail.com"];
// Concrete start for each window when the Zoom meeting is created (ET).
const BOOKING_WINDOW_START = { morning: "10:00:00", afternoon: "14:00:00" };

// ET calendar parts for an instant, without depending on the host timezone.
function etParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: BOOKING_TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(d);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
// The offered appointment days: [{ date: "YYYY-MM-DD", weekday: 0..6 (Sun..Sat) }].
// Default mode: Mon–Fri business days only (the Nov 26 single-slot rule).
// Escape-hatch mode (BOOKING_EVERY_DAY=true): every consecutive day.
function bookingDays(now = new Date()) {
  const t = etParts(now);
  const out = [];
  const cur = new Date(Date.UTC(t.y, t.m - 1, t.d));
  while (out.length < BOOKING_DAYS) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const wd = cur.getUTCDay();
    if (BOOKING_EVERY_DAY || (wd >= 1 && wd <= 5)) out.push({ date: ymd(cur.getUTCFullYear(), cur.getUTCMonth() + 1, cur.getUTCDate()), weekday: wd });
  }
  return out;
}

// Returns { ok:true, booking } or { ok:false, error, error_code? }
// The estimate is NOT taken from the body — index.js recomputes it from
// the validated answers with the engine, like /api/submissions does.
function checkBooking(b, now = new Date()) {
  if (!b || typeof b !== "object") return { ok: false, error: "missing booking" };
  const name = str(b.name);
  // Company name is REQUIRED on the booking (Nov 26 2026, Miguel's
  // direction): the lead must carry the company so the team can follow
  // back up — a booking without it cannot be worked.
  const company_name = str(b.company_name);
  const email = str(b.email, 200);
  const phone = str(b.phone, 40);
  const note = str(b.note, 500);
  if (!name) return { ok: false, error: "name is required" };
  if (!company_name) return { ok: false, error: "company name is required" };
  const err = emailError(email);
  if (err === "tld") return { ok: false, error_code: "email_tld", error: "That email ending is not a real domain — for example, .jet is not valid. Did you mean .com? Check the ending (.com, .net, .org…)" };
  if (err) return { ok: false, error_code: "email_format", error: "That email is not in a valid format. It should look like name@company.com, with no spaces." };
  const date = str(b.date, 10);
  if (!bookingDays(now).some(x => x.date === date)) return { ok: false, error: "choose one of the offered appointment days" };
  if (!BOOKING_WINDOWS.includes(b.window)) return { ok: false, error: "the only slot is the daily 2:00 PM ET Zoom call" };
  const a = checkAnswers(b.answers);
  if (!a.ok) return { ok: false, error: a.error };
  // Qualifiers ride along when the funnel sends them (they were answered at
  // the price gate). Optional here — the lead row is the canonical store —
  // but when present they must be valid codes, and they are stored on the
  // booking too so the appointments view shows them.
  const hasQ = b.qualifiers && typeof b.qualifiers === "object" ? Object.keys(b.qualifiers).length > 0 : ["industry","data_authority","employee_band","years_band","position"].some(k => b[k] !== undefined);
  let qualifiers = null;
  if (hasQ) {
    const q = checkQualifiers(b.qualifiers && typeof b.qualifiers === "object" ? b.qualifiers : b, false);
    qualifiers = q.qualifiers;
  }
  return { ok: true, booking: { name, company_name, email, phone: phone || null, note: note || null, appt_date: date, window: b.window, answers: a.answers, qualifiers } };
}

module.exports = { SECTORS, YEARS, EMPLOYEES, TYPES, VOLUMES, REVENUE, FORMATS, FREQUENCY, TRACKS, STATUSES, MANIFEST_ITEMS, checkAnswers, checkContact, toEngineInput, str, KNOWN_TLDS, emailError, isValidEmail, INDUSTRIES, AUTHORITY, EMPLOYEE_BANDS, YEARS_BANDS, POSITIONS, LEAD_STATUSES, LEAD_SOURCES, checkQualifiers, checkLead, LEAD_SCORE_POINTS, scoreLead, BOOKING_WINDOWS, BOOKING_SLOT, BOOKING_STATUSES, BOOKING_DAYS, BOOKING_EVERY_DAY, BOOKING_TZ, BOOKING_WINDOW_START, ZOOM_INVITEES, etParts, bookingDays, checkBooking };
