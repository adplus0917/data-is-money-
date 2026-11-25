// ============================================================
// Private file storage for data samples.
// Files are written to UPLOAD_DIR with random names, OUTSIDE the
// public folder, so nobody can open them by guessing a URL. Only
// the team panel (after sign-in) can download them.
// On Render, point UPLOAD_DIR at the persistent disk (/var/data/uploads).
// ============================================================
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIR = process.env.UPLOAD_DIR || path.join(__dirname, "..", "data", "uploads");
const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 20);
const ALLOWED = [".pdf", ".xlsx", ".xls", ".csv", ".txt", ".json", ".zip", ".doc", ".docx", ".jpg", ".jpeg", ".png", ".heic", ".qbo", ".iif"];

function allowed(name) { return ALLOWED.includes(path.extname(name || "").toLowerCase()); }

async function save(file) {
  await fs.promises.mkdir(DIR, { recursive: true });
  const ext = path.extname(file.originalname).toLowerCase();
  const stored = crypto.randomBytes(16).toString("hex") + ext;
  await fs.promises.writeFile(path.join(DIR, stored), file.buffer, { mode: 0o600 });
  return stored;
}

function pathOf(stored) {
  const p = path.join(DIR, path.basename(stored));   // basename blocks ../ tricks
  return fs.existsSync(p) ? p : null;
}

module.exports = { save, pathOf, allowed, MAX_MB, ALLOWED, DIR };
