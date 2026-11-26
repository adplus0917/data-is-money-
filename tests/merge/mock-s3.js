'use strict';
// Minimal in-process S3-compatible stub used ONLY by the smoke test.
// Implements just the multipart subset the B2 transport uses:
//   POST   /<bucket>/<key>?uploads                 -> CreateMultipartUpload
//   PUT    /<bucket>/<key>?partNumber&uploadId     -> UploadPart (ETag header)
//   GET    /<bucket>/<key>?uploadId                -> ListParts (NoSuchUpload after completion)
//   POST   /<bucket>/<key>?uploadId  (XML body)    -> CompleteMultipartUpload
//   DELETE /<bucket>/<key>?uploadId                -> AbortMultipartUpload
//   GET    /__objects__                            -> test-only JSON dump { key: {bucket,size,sha256} }
// It also checks that every S3 request carries an AWS4-HMAC-SHA256
// Authorization header, so the test exercises the real signing code path.
const http = require('http');
const crypto = require('crypto');

function startMockS3() {
  const uploads = new Map(); // uploadId -> { bucket, key, parts: Map<partNumber,{etag,size,buf}> }
  const objects = new Map(); // key -> { bucket, size, sha256, etag }
  let counter = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      const body = Buffer.concat(parts);

      if (url.pathname === '/__objects__') {
        const out = {};
        for (const [k, v] of objects) out[k] = v;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(out));
      }

      const auth = req.headers.authorization || '';
      if (!auth.startsWith('AWS4-HMAC-SHA256 ') || !auth.includes('SignedHeaders=host;x-amz-content-sha256;x-amz-date')) {
        res.writeHead(403, { 'Content-Type': 'application/xml' });
        return res.end('<Error><Code>InvalidAccessKeyId</Code><Message>missing or malformed SigV4 Authorization header</Message></Error>');
      }

      const seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const bucket = seg[0];
      const key = seg.slice(1).join('/');
      const q = url.searchParams;
      const xml = (status, s) => { res.writeHead(status, { 'Content-Type': 'application/xml' }); res.end(s); };

      // CreateMultipartUpload
      if (req.method === 'POST' && q.has('uploads')) {
        const uploadId = `mock-upload-${++counter}`;
        uploads.set(uploadId, { bucket, key, parts: new Map() });
        return xml(200, `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
      }

      const uploadId = q.get('uploadId');
      const up = uploadId ? uploads.get(uploadId) : null;

      // UploadPart
      if (req.method === 'PUT' && q.has('partNumber')) {
        if (!up) return xml(404, '<Error><Code>NoSuchUpload</Code></Error>');
        const pn = parseInt(q.get('partNumber'), 10);
        const etag = `"${crypto.createHash('md5').update(body).digest('hex')}"`;
        up.parts.set(pn, { etag, size: body.length, buf: Buffer.from(body) });
        res.writeHead(200, { ETag: etag });
        return res.end();
      }

      // ListParts
      if (req.method === 'GET' && uploadId) {
        if (!up) return xml(404, '<Error><Code>NoSuchUpload</Code></Error>');
        const list = [...up.parts.entries()].sort((a, b) => a[0] - b[0])
          .map(([pn, p]) => `<Part><PartNumber>${pn}</PartNumber><ETag>${p.etag}</ETag><Size>${p.size}</Size></Part>`).join('');
        return xml(200, `<?xml version="1.0" encoding="UTF-8"?><ListPartsResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId>${list}</ListPartsResult>`);
      }

      // CompleteMultipartUpload
      if (req.method === 'POST' && uploadId) {
        if (!up) return xml(404, '<Error><Code>NoSuchUpload</Code></Error>');
        const wanted = [...body.toString('utf8').matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => parseInt(m[1], 10));
        const bufs = wanted.map((pn) => {
          const p = up.parts.get(pn);
          if (!p) { xml(400, '<Error><Code>InvalidPart</Code></Error>'); throw new Error('invalid part'); }
          return p.buf;
        });
        const all = Buffer.concat(bufs);
        const sha256 = crypto.createHash('sha256').update(all).digest('hex');
        const etag = `"${crypto.createHash('md5').update(all).digest('hex')}-${wanted.length}"`;
        objects.set(key, { bucket, size: all.length, sha256, etag });
        uploads.delete(uploadId);
        return xml(200, `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Location>http://mock/${bucket}/${key}</Location><Bucket>${bucket}</Bucket><Key>${key}</Key><ETag>${etag}</ETag></CompleteMultipartUploadResult>`);
      }

      // AbortMultipartUpload
      if (req.method === 'DELETE' && uploadId) {
        uploads.delete(uploadId);
        res.writeHead(204);
        return res.end();
      }

      return xml(400, '<Error><Code>NotImplemented</Code><Message>mock-s3: unhandled request</Message></Error>');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, objects }));
  });
}

module.exports = { startMockS3 };
