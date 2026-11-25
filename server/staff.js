// ============================================================
// Staff sign-in for the owner CRM (individual accounts).
// Each person on Miguel's team gets their OWN login (email + password,
// scrypt-hashed in staff_users) and a role: 'admin' (full, incl. staff
// management) or 'ops' (day-to-day). The session is a signed, HttpOnly
// cookie carrying the staff identity, so every action can be written to
// the audit log under that person's name (actor "staff:<email>").
//
// The legacy shared ADMIN_PASSWORD cookie (server/auth.js) still works
// as a bootstrap / emergency admin: guard() accepts it and treats it as
// role 'admin' with actor "admin@<ip>". Staff sessions are separate
// from seller accounts and from buyer data-room sessions.
// ============================================================
const crypto = require("crypto");
const auth = require("./auth");

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const HOURS = 12;
const PROD = process.env.NODE_ENV === "production";
const COOKIE = "dp_staff";

const sign = v => crypto.createHmac("sha256", SECRET).update(v).digest("hex");

/* ---------- passwords (scrypt) ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
function verifyPassword(pw, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored || "").split("$");
    if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    const given = crypto.scryptSync(String(pw), Buffer.from(saltHex, "hex"), expected.length);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  } catch { return false; }
}

/* ---------- session cookie ---------- */
function issue(res, user) {
  const payload = Buffer.from(JSON.stringify({
    uid: user.id, email: user.email, name: user.name, role: user.role,
    exp: Date.now() + HOURS * 3600e3,
  })).toString("base64url");
  res.setHeader("Set-Cookie", `${COOKIE}=${payload}.${sign(payload)}; HttpOnly; Path=/; Max-Age=${HOURS * 3600}; SameSite=Strict${PROD ? "; Secure" : ""}`);
}
function clear(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict${PROD ? "; Secure" : ""}`);
}
// Returns {id, email, name, role, actor} for a valid staff cookie, else null.
// Never throws on a malformed cookie (same lesson as the auth-cookie fix).
function staffOf(req) {
  try {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || "");
    if (!m) return null;
    const [payload, sig] = m[1].split(".");
    if (!payload || !sig || !/^[0-9a-f]{64}$/.test(sig)) return null;
    const given = Buffer.from(sig, "hex"), expected = Buffer.from(sign(payload), "hex");
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.email || !["admin", "ops"].includes(data.role) || Number(data.exp) <= Date.now()) return null;
    return { id: data.uid, email: data.email, name: data.name, role: data.role, actor: `staff:${data.email}` };
  } catch { return null; }
}
// Any valid team identity: a staff session, or the legacy shared-password
// session (bootstrap/emergency admin). Sets req.staff either way.
function who(req) {
  const s = staffOf(req);
  if (s) return s;
  if (auth.isAdmin(req)) return { id: null, email: null, name: "Admin (shared login)", role: "admin", legacy: true, actor: `admin@${req.ip}` };
  return null;
}
function guard(req, res, next) {
  const w = who(req);
  if (!w) return res.status(401).json({ error: "sign in required" });
  req.staff = w;
  next();
}
function requireAdminRole(req, res, next) {
  if (!req.staff) return res.status(401).json({ error: "sign in required" });
  if (req.staff.role !== "admin") return res.status(403).json({ error: "admin role required" });
  next();
}
const actorOf = req => (req.staff ? req.staff.actor : `admin@${req.ip}`);

module.exports = { hashPassword, verifyPassword, issue, clear, staffOf, who, guard, requireAdminRole, actorOf };
