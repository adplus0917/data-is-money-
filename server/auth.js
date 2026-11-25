// ============================================================
// Team-panel sign-in.
// One shared password (ADMIN_PASSWORD). On success the server sets a
// signed, HttpOnly cookie that lasts 12 hours. Every /api/admin route
// checks that cookie. Wrong passwords are rate-limited per IP.
// ============================================================
const crypto = require("crypto");

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const PASSWORD = process.env.ADMIN_PASSWORD || "";
const HOURS = 12;
const PROD = process.env.NODE_ENV === "production";

const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const sign = v => crypto.createHmac("sha256", SECRET).update(v).digest("hex");

function passwordOk(given) {
  if (!PASSWORD) return false;
  return crypto.timingSafeEqual(sha(given), sha(PASSWORD));
}

function issue(res) {
  const exp = String(Date.now() + HOURS * 3600e3);
  const value = exp + "." + sign(exp);
  res.setHeader("Set-Cookie", `dp_admin=${value}; HttpOnly; Path=/; Max-Age=${HOURS * 3600}; SameSite=Strict${PROD ? "; Secure" : ""}`);
}
function clear(res) {
  res.setHeader("Set-Cookie", `dp_admin=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict${PROD ? "; Secure" : ""}`);
}
function readCookie(req) {
  const m = /(?:^|;\s*)dp_admin=([^;]+)/.exec(req.headers.cookie || "");
  return m ? m[1] : null;
}
function isAdmin(req) {
  // MERGE FIX (auth-cookie crash): a malformed cookie must mean "not signed
  // in" (401), never a thrown 500. Buffer.from(x, "hex") silently truncates
  // non-hex input, so a 64-char non-hex signature used to reach
  // timingSafeEqual with mismatched buffer lengths and throw. Validate the
  // hex shape and buffer lengths first, and never let this check throw.
  try {
    const v = readCookie(req);
    if (!v) return false;
    const [exp, sig] = v.split(".");
    if (!exp || !sig || !/^[0-9a-f]{64}$/.test(sig)) return false;
    const given = Buffer.from(sig, "hex"), expected = Buffer.from(sign(exp), "hex");
    if (given.length !== expected.length) return false;
    return crypto.timingSafeEqual(given, expected) && Number(exp) > Date.now();
  } catch { return false; }
}
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: "sign in required" });
}

module.exports = { passwordOk, issue, clear, isAdmin, requireAdmin, configured: () => !!PASSWORD };
