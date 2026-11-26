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
   Slots are whole-day picks + a time window, in America/New_York.
   EVERY-DAY AVAILABILITY (Nov 26 2026, Miguel's direction — "we want to
   put a Zoom meeting every day"): the offered list is the next
   BOOKING_DAYS calendar days starting tomorrow ET, ALL seven weekdays
   (weekends included). Config points: BOOKING_DAYS (how many days are
   offered, default 7, env-overridable) and BOOKING_EVERY_DAY (default
   true; set env BOOKING_EVERY_DAY=false to fall back to Mon–Fri only).
   The windows span 9 AM–5 PM ET (morning 9–12, afternoon 1–5; the Zoom
   start times per window are BOOKING_WINDOW_START below).
   The client renders the same list with the same algorithm (public/app.js
   bookingDaysClient); the server re-derives it here and rejects anything
   else, so a tampered browser can't book a date three months out.
   --------------------------------------------------------------------------- */
const BOOKING_WINDOWS = ["morning", "afternoon"];
const BOOKING_STATUSES = ["pending", "confirmed", "done"];
const BOOKING_DAYS = Math.max(1, Math.min(14, parseInt(process.env.BOOKING_DAYS || "7", 10) || 7));
const BOOKING_EVERY_DAY = process.env.BOOKING_EVERY_DAY !== "false";
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
// Every-day mode (default): the next BOOKING_DAYS calendar days, weekends
// included. Fallback mode (BOOKING_EVERY_DAY=false): Mon–Fri only.
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
  if (!BOOKING_WINDOWS.includes(b.window)) return { ok: false, error: "choose a morning or afternoon window" };
  const a = checkAnswers(b.answers);
  if (!a.ok) return { ok: false, error: a.error };
  return { ok: true, booking: { name, company_name, email, phone: phone || null, note: note || null, appt_date: date, window: b.window, answers: a.answers } };
}

module.exports = { SECTORS, YEARS, EMPLOYEES, TYPES, VOLUMES, REVENUE, FORMATS, FREQUENCY, TRACKS, STATUSES, MANIFEST_ITEMS, checkAnswers, checkContact, toEngineInput, str, KNOWN_TLDS, emailError, isValidEmail, BOOKING_WINDOWS, BOOKING_STATUSES, BOOKING_DAYS, BOOKING_EVERY_DAY, BOOKING_TZ, BOOKING_WINDOW_START, ZOOM_INVITEES, etParts, bookingDays, checkBooking };
