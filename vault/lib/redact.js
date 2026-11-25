// ============================================================
// Redaction for viewing copies. Works on TEXT-BASED files only
// (CSV, TXT, JSON, IIF, QBO, and XLSX converted to CSV per sheet).
// PDFs, images, Word files and ZIPs cannot be redacted reliably by
// pattern; when an engagement asks for redaction they are WITHHELD
// from the viewing copy and listed for the team (never silently shown).
// ============================================================
const RULES = [
  ["ssn", /\b\d{3}-\d{2}-\d{4}\b/g],
  ["card", /\b(?:\d[ -]?){13,19}\b/g],
  ["email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
  ["phone", /(?:\+?1[ .-]?)?\(?\b\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g],
  ["routing_account", /\b(?:acct|account|routing|aba|cuenta)\s*(?:no\.?|number|#|n[uú]m(?:ero)?\.?)?\s*[:#]?\s*\d{4,17}\b/gi],
];
const TEXT_TYPES = ["csv", "txt", "json", "iif", "qbo"];

function redactText(s, policy = {}) {
  let count = 0;
  for (const [name, re] of RULES) {
    if (policy.keep && policy.keep.includes(name)) continue;
    s = s.replace(re, m => { count++; return `[${name.toUpperCase()}]`; });
  }
  // whole columns by header name (CSV), e.g. {"columns":["Customer","Address"]}
  if (policy.columns && policy.columns.length) {
    const lines = s.split(/\r?\n/), cols = splitCsv(lines[0] || "");
    const idx = cols.map((c, i) => policy.columns.some(p => c.trim().toLowerCase() === p.toLowerCase()) ? i : -1).filter(i => i >= 0);
    if (idx.length) {
      s = [lines[0], ...lines.slice(1).map(l => { const c = splitCsv(l); idx.forEach(i => { if (c[i] !== undefined && c[i] !== "") { c[i] = "[REDACTED]"; count++; } }); return c.map(csvQuote).join(","); })].join("\n");
    }
  }
  return { text: s, count };
}

function splitCsv(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur); return out;
}
const csvQuote = v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;

// XLSX → one CSV per sheet (values only, no formulas, no macros)
async function xlsxToCsvs(buf, maxRows = 200000) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const out = [];
  wb.eachSheet(ws => {
    const lines = []; let n = 0;
    ws.eachRow({ includeEmpty: false }, row => {
      if (n++ >= maxRows) return;
      const vals = [];
      for (let c = 1; c <= row.cellCount; c++) {
        let v = row.getCell(c).value;
        if (v && typeof v === "object") v = v.result ?? v.text ?? (v.richText ? v.richText.map(r => r.text).join("") : v instanceof Date ? v.toISOString().slice(0, 10) : "");
        vals.push(csvQuote(String(v ?? "")));
      }
      lines.push(vals.join(","));
    });
    out.push({ sheet: ws.name, csv: lines.join("\n"), rows: n });
  });
  return out;
}

module.exports = { redactText, splitCsv, xlsxToCsvs, TEXT_TYPES };
