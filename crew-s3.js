'use strict';
// Backblaze B2 transport for the crew upload router (server/crew-upload.js)
// — S3-compatible API. Merged into the DATA Patrimonio site codebase
// Nov 26 2026 from the standalone crew-upload service (s3.js there);
// logic unchanged.
//
// Why the S3 API and not the native B2 API: B2's S3-compatible endpoint
// gives us multipart uploads (CreateMultipartUpload / UploadPart /
// CompleteMultipartUpload / ListParts) with the exact resumable semantics
// this service already had on Google Drive — sequential chunks, a
// server-confirmed resume offset, and completion only when every part has
// landed. The native B2 API's large-file flow can do the same, but the S3
// surface is the documented, stable path for B2 application keys and keeps
// the door open to any S3-compatible store later. Signing is AWS Signature
// Version 4 implemented with node:crypto only, so the service stays at
// zero npm dependencies.
//
// Addressing: path-style (<endpoint>/<bucket>/<key>), which B2 supports.
//
// Config (env):
//   B2_S3_ENDPOINT     e.g. https://s3.us-east-005.backblazeb2.com
//                      (the region is parsed out of the host name; override
//                      with B2_S3_REGION if your endpoint doesn't carry it)
//   B2_BUCKET          bucket for crew uploads (default "crewuploads").
//                      NOTE: this is NOT the DATA seller-data bucket
//                      (datapatrimoniostaging) — that one stays segregated.
//   B2_KEY_ID          application key id (server-side only, never commit)
//   B2_APPLICATION_KEY application key secret (server-side only)
const crypto = require('crypto');

// Non-final chunks must align to 256 KiB (kept from the Drive design so the
// browser page and API contract are unchanged), and — B2/S3 multipart rule —
// every part except the last must be at least 5 MiB. The browser sends
// 8 MiB chunks on the legacy proxied path, so both rules hold in practice.
const CHUNK_GRANULARITY = 256 * 1024;
const MIN_PART_BYTES = 5 * 1024 * 1024;

// Direct-to-B2 path (Nov 27 2026 speed fix): the browser uploads parts
// straight to B2 with presigned URLs — 16 MiB parts (fewer round trips than
// the legacy 8 MiB proxied chunks; 16 MiB × 10,000 S3 part limit = 160 GiB,
// far above MAX_FILE_BYTES). The server only creates the multipart session,
// signs part URLs, and completes from B2's own part list.
const DIRECT_PART_BYTES = 16 * 1024 * 1024;
const PRESIGN_EXPIRES_SECONDS = 3600;

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}
// RFC 3986 encoding for one URI path segment / query value.
function enc(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
function encodeKey(key) {
  return key.split('/').map(enc).join('/');
}
function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function xmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : null;
}

class S3MultipartTransport {
  constructor({ endpoint, bucket, keyId, applicationKey, region }) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.bucket = bucket;
    this.keyId = keyId;
    this.applicationKey = applicationKey;
    this.region = region || S3MultipartTransport.regionFromEndpoint(this.endpoint);
    this.mode = 'b2-s3';
  }

  static regionFromEndpoint(endpoint) {
    try {
      const host = new URL(endpoint).hostname;
      const m = host.match(/^s3\.([a-z0-9-]+)\.backblazeb2\.com$/i);
      if (m) return m[1];
    } catch {}
    return 'us-east-005';
  }

  // One signed S3 request. body is a Buffer or string (may be empty).
  async request(method, key, { query = {}, body = Buffer.alloc(0), contentType } = {}) {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const payloadHash = sha256hex(payload);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    const host = new URL(this.endpoint).host;

    const path = `/${enc(this.bucket)}/${encodeKey(key)}`;
    const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalHeaders =
      `host:${host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const canonicalRequest = [method, path, qs, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
    const kDate = hmac('AWS4' + this.applicationKey, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

    const url = `${this.endpoint}${path}${qs ? '?' + qs : ''}`;
    const res = await fetch(url, {
      method,
      headers: {
        // 'host' is a forbidden fetch header; undici sends Host: <url host>
        // automatically, which is exactly the value signed above.
        Authorization: `AWS4-HMAC-SHA256 Credential=${this.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        ...(contentType ? { 'Content-Type': contentType } : {}),
      },
      body: payload.length ? payload : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      const code = xmlTag(text, 'Code') || '';
      throw new Error(`B2 S3 ${method} ${key} failed: ${res.status} ${code} ${text.slice(0, 300)}`);
    }
    return { res, text };
  }

  // Start a multipart upload for <key>. Returns the session handle the
  // server keeps: { uploadId, key, parts: [{partNumber, etag, size}], received }.
  async initSession({ key, mimeType }) {
    const { text } = await this.request('POST', key, {
      query: { uploads: '' },
      contentType: mimeType || 'application/octet-stream',
    });
    const uploadId = xmlTag(text, 'UploadId');
    if (!uploadId) throw new Error('B2 CreateMultipartUpload returned no UploadId');
    return { uploadId, key, parts: [], received: 0 };
  }

  // Upload one chunk as the next part. Chunks must arrive in order (the
  // browser uploads sequentially and resumes from sessionOffset first).
  // Returns { complete, offset, file? } — same contract as the old transport.
  async sendChunk(session, chunk, start, total) {
    if (start !== session.received) return { complete: false, offset: session.received };
    const partNumber = session.parts.length + 1;
    const { res } = await this.request('PUT', session.key, {
      query: { partNumber: String(partNumber), uploadId: session.uploadId },
      body: chunk,
    });
    const etag = res.headers.get('etag');
    if (!etag) throw new Error('B2 UploadPart returned no ETag');
    session.parts.push({ partNumber, etag, size: chunk.length });
    session.received += chunk.length;
    if (session.received >= total) {
      const file = await this.complete(session);
      return { complete: true, offset: total, file };
    }
    return { complete: false, offset: session.received };
  }

  async complete(session) {
    const partsXml = session.parts
      .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`)
      .join('');
    const body = `<CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`;
    const { text } = await this.request('POST', session.key, {
      query: { uploadId: session.uploadId },
      body,
      contentType: 'application/xml',
    });
    return {
      key: session.key,
      bucket: this.bucket,
      etag: xmlTag(text, 'ETag') || null,
      location: xmlTag(text, 'Location') || null,
    };
  }

  // List every part B2 already holds for this session (paginated).
  async listParts(session) {
    const parts = [];
    let marker = null;
    for (;;) {
      const query = { uploadId: session.uploadId };
      if (marker != null) query['part-number-marker'] = String(marker);
      const { text } = await this.request('GET', session.key, { query });
      const re = /<Part>([\s\S]*?)<\/Part>/g;
      let m;
      while ((m = re.exec(text))) {
        parts.push({
          partNumber: parseInt(xmlTag(m[1], 'PartNumber'), 10),
          etag: xmlTag(m[1], 'ETag'),
          size: parseInt(xmlTag(m[1], 'Size'), 10),
        });
      }
      if (xmlTag(text, 'IsTruncated') !== 'true') break;
      marker = xmlTag(text, 'NextPartNumberMarker');
      if (marker == null) break;
    }
    parts.sort((a, b) => a.partNumber - b.partNumber);
    return parts;
  }

  // Resume support: ask B2 which parts it already has; offset = sum of part
  // sizes. If the upload was already completed, B2 answers NoSuchUpload and
  // we report complete (the server drops finished sessions, so this is a
  // belt-and-braces path for a status call racing the final chunk).
  async sessionOffset(session, total) {
    try {
      const parts = await this.listParts(session);
      session.parts = parts;
      session.received = parts.reduce((n, p) => n + p.size, 0);
      return { complete: false, offset: session.received };
    } catch (err) {
      if (/NoSuchUpload/.test(err.message)) {
        return { complete: true, offset: total, file: { key: session.key, bucket: this.bucket } };
      }
      throw err;
    }
  }

  // Same as sessionOffset, plus the part numbers present — the direct-path
  // page needs them to skip parts that already landed and re-sign the rest.
  async sessionParts(session, total) {
    try {
      const parts = await this.listParts(session);
      session.parts = parts;
      session.received = parts.reduce((n, p) => n + p.size, 0);
      return { complete: false, offset: session.received, partNumbers: parts.map((p) => p.partNumber) };
    } catch (err) {
      if (/NoSuchUpload/.test(err.message)) {
        return { complete: true, offset: total, partNumbers: [], file: { key: session.key, bucket: this.bucket } };
      }
      throw err;
    }
  }

  _signingKey(dateStamp) {
    const kDate = hmac('AWS4' + this.applicationKey, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, 's3');
    return hmac(kService, 'aws4_request');
  }

  // Presigned UploadPart URL (SigV4 query-string auth, UNSIGNED-PAYLOAD):
  // the browser PUTs the part bytes straight to B2 with this URL — no data
  // transits this server. Only "host" is signed, so the browser may send
  // whatever Content-Type the file slice carries.
  presignPart(session, partNumber, expiresSeconds = PRESIGN_EXPIRES_SECONDS) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const host = new URL(this.endpoint).host;
    const path = `/${enc(this.bucket)}/${encodeKey(session.key)}`;
    const query = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.keyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresSeconds),
      'X-Amz-SignedHeaders': 'host',
      partNumber: String(partNumber),
      uploadId: session.uploadId,
    };
    const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
    const canonicalRequest = ['PUT', path, qs, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
    const signature = crypto.createHmac('sha256', this._signingKey(dateStamp)).update(stringToSign, 'utf8').digest('hex');
    return `${this.endpoint}${path}?${qs}&X-Amz-Signature=${signature}`;
  }

  // Complete a direct-path session from B2's OWN part list — the etags the
  // browser saw are never trusted; the server asks B2 what actually landed.
  async completeDirect(session) {
    const parts = await this.listParts(session);
    if (!parts.length) throw new Error('cannot complete: B2 holds no parts for this session');
    session.parts = parts;
    session.received = parts.reduce((n, p) => n + p.size, 0);
    return this.complete(session);
  }

  // Best-effort cleanup for abandoned sessions (not wired to a timer; the
  // bucket should also carry a lifecycle rule aborting stale multipart
  // uploads — see README).
  async abort(session) {
    try {
      await this.request('DELETE', session.key, { query: { uploadId: session.uploadId } });
    } catch {}
  }
}

function createStorage(env) {
  const missing = ['B2_S3_ENDPOINT', 'B2_KEY_ID', 'B2_APPLICATION_KEY'].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `Missing B2 config: ${missing.join(', ')} — set them from the Backblaze B2 ` +
      'application key created for this service (see README go-live steps).'
    );
  }
  const transport = new S3MultipartTransport({
    endpoint: env.B2_S3_ENDPOINT,
    bucket: env.B2_BUCKET || 'crewuploads',
    keyId: env.B2_KEY_ID,
    applicationKey: env.B2_APPLICATION_KEY,
    region: env.B2_S3_REGION || undefined,
  });
  return { transport, mode: transport.mode, bucket: transport.bucket };
}

module.exports = { createStorage, S3MultipartTransport, CHUNK_GRANULARITY, MIN_PART_BYTES, DIRECT_PART_BYTES, PRESIGN_EXPIRES_SECONDS };
