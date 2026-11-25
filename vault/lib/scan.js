// ============================================================
// One streaming pass over a file: SHA-256, format check (the first
// bytes must match the file extension) and a ClamAV virus scan.
// ClamAV runs as its own service (clamd) on CLAMD_HOST:CLAMD_PORT.
// ============================================================
const crypto = require("crypto");
const net = require("net");

const SIGS = {
  pdf: [[0, "25504446"]],                          // %PDF
  zip: [[0, "504b0304"], [0, "504b0506"]],         // PK..
  xlsx: [[0, "504b0304"]], docx: [[0, "504b0304"]],
  xls: [[0, "d0cf11e0a1b11ae1"]], doc: [[0, "d0cf11e0a1b11ae1"]],
  png: [[0, "89504e47"]], jpg: [[0, "ffd8ff"]], jpeg: [[0, "ffd8ff"]],
  heic: [[4, "66747970"]],                         // ....ftyp
};
const TEXT = ["csv", "txt", "json", "qbo", "iif"];

function formatOk(ext, head) {
  ext = String(ext || "").toLowerCase().replace(/^\./, "");
  if (TEXT.includes(ext)) return !head.subarray(0, 4096).includes(0);   // text files contain no NUL bytes
  const sigs = SIGS[ext];
  if (!sigs) return false;
  const hex = head.toString("hex");
  return sigs.some(([off, sig]) => hex.startsWith(sig, off * 2));
}

function clamdSession() {
  const host = process.env.CLAMD_HOST;
  if (!host) return null;
  const port = Number(process.env.CLAMD_PORT || 3310);
  const sock = net.connect({ host, port });
  sock.setTimeout(Number(process.env.CLAMD_TIMEOUT_MS || 120000));
  let reply = "", failed = null;
  const done = new Promise(resolve => {
    sock.on("data", d => { reply += d.toString(); });
    sock.on("timeout", () => { failed = "clamd timeout"; sock.destroy(); });
    sock.on("error", e => { failed = "clamd: " + e.message; });
    sock.on("close", () => {
      const r = reply.replace(/\0/g, "").trim();
      if (failed && !r) return resolve({ status: "error", detail: failed });
      if (/\bOK$/.test(r)) return resolve({ status: "clean", detail: "clamd OK" });
      if (/FOUND$/.test(r)) return resolve({ status: "infected", detail: r.replace(/^stream:\s*/, "") });
      resolve({ status: "error", detail: r || failed || "no reply" });
    });
  });
  sock.write("zINSTREAM\0");
  return {
    write(chunk) {
      for (let i = 0; i < chunk.length; i += 65536) {
        const part = chunk.subarray(i, i + 65536), len = Buffer.alloc(4);
        len.writeUInt32BE(part.length); sock.write(len); sock.write(part);
      }
    },
    end() { sock.write(Buffer.alloc(4)); return done; },
    abort() { sock.destroy(); },
  };
}

// readable: a Node stream or async iterable of Buffers
async function scanStream(readable, ext, { onChunk } = {}) {
  const hash = crypto.createHash("sha256");
  const clam = clamdSession();
  let size = 0, head = Buffer.alloc(0);
  try {
    for await (const c of readable) {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
      hash.update(b); size += b.length;
      if (head.length < 4096) head = Buffer.concat([head, b.subarray(0, 4096 - head.length)]);
      if (clam) clam.write(b);
      if (onChunk) onChunk(b);
    }
  } catch (e) { if (clam) clam.abort(); throw e; }
  const virus = clam ? await clam.end() : { status: "skipped", detail: "CLAMD_HOST not set" };
  const fmt = formatOk(ext, head);
  const scan_status = virus.status === "infected" ? "infected" : !fmt ? "format_mismatch" : virus.status;
  return { sha256: hash.digest("hex"), size, scan_status, scan_detail: virus.status === "infected" ? virus.detail : !fmt ? `content does not look like .${ext}` : virus.detail };
}

const scanBuffer = (buf, ext) => scanStream([buf], ext);
const sha256Stream = async s => { const h = crypto.createHash("sha256"); for await (const c of s) h.update(c); return h.digest("hex"); };

module.exports = { scanStream, scanBuffer, sha256Stream, formatOk };
