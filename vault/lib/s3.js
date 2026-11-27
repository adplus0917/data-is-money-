// ============================================================
// Storage by ROLE. Each process only gets the keys for the buckets
// it is allowed to touch, through its own environment variables:
//
//   role        bucket                  who holds these keys
//   staging     cloud staging (7 days)  web (PUT only) · ingest (GET+DELETE)
//   master      vault rack, private     ingest (PUT+GET) · builder (GET only)
//   quarantine  vault rack              ingest (PUT only)
//   viewing     vault rack              builder (PUT+DELETE) · data room (GET only)
//
// Variables per role, e.g. for master:
//   MASTER_BUCKET, MASTER_S3_ENDPOINT, MASTER_S3_REGION,
//   MASTER_ACCESS_KEY_ID, MASTER_SECRET_ACCESS_KEY, MASTER_S3_PATH_STYLE (default true)
// A role whose *_BUCKET is not set simply does not exist in that process.
// ============================================================
const {
  S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand,
  CopyObjectCommand, ListObjectsV2Command, DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const cache = {};

function role(name) {
  if (cache[name] !== undefined) return cache[name];
  const P = name.toUpperCase() + "_", e = process.env;
  if (!e[P + "BUCKET"]) return (cache[name] = null);
  const client = new S3Client({
    endpoint: e[P + "S3_ENDPOINT"] || undefined,
    region: e[P + "S3_REGION"] || "us-east-1",
    forcePathStyle: e[P + "S3_PATH_STYLE"] !== "false",
    // Plain uploads work on every S3-compatible store (MinIO, R2, Wasabi…).
    // Integrity is checked by our own SHA-256 on every copy anyway.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: e[P + "ACCESS_KEY_ID"] || "", secretAccessKey: e[P + "SECRET_ACCESS_KEY"] || "" },
  });
  const Bucket = e[P + "BUCKET"];
  const sse = e[P + "SSE"] ? { ServerSideEncryption: e[P + "SSE"], ...(e[P + "SSE_KMS_KEY_ID"] ? { SSEKMSKeyId: e[P + "SSE_KMS_KEY_ID"] } : {}) } : {};
  const api = {
    name, bucket: Bucket, client,
    async put(Key, Body, { contentType, metadata, length } = {}) {
      if (Buffer.isBuffer(Body) || typeof Body === "string" || length != null)
        return client.send(new PutObjectCommand({ Bucket, Key, Body, ContentType: contentType, Metadata: metadata, ContentLength: length, ...sse }));
      // streams of unknown length: multipart upload in 8 MB parts
      return new Upload({ client, params: { Bucket, Key, Body, ContentType: contentType, Metadata: metadata, ...sse }, partSize: 8 * 1048576, queueSize: 2 }).done();
    },
    async getStream(Key) { const r = await client.send(new GetObjectCommand({ Bucket, Key })); return r.Body; },
    async getBuffer(Key) {
      const s = await api.getStream(Key); const chunks = [];
      for await (const c of s) chunks.push(c);
      return Buffer.concat(chunks);
    },
    async head(Key) {
      try { return await client.send(new HeadObjectCommand({ Bucket, Key })); }
      catch (err) { if (err.$metadata && err.$metadata.httpStatusCode === 404 || err.name === "NotFound" || err.name === "NoSuchKey") return null; throw err; }
    },
    del(Key) { return client.send(new DeleteObjectCommand({ Bucket, Key })); },
    // server-side copy INTO this role's bucket from another bucket on the same endpoint
    copyFrom(srcBucket, srcKey, Key, metadata) {
      return client.send(new CopyObjectCommand({ Bucket, Key, CopySource: `${srcBucket}/${srcKey.split("/").map(encodeURIComponent).join("/")}`, Metadata: metadata, MetadataDirective: metadata ? "REPLACE" : "COPY", ...sse }));
    },
    async list(Prefix) {
      const out = []; let ContinuationToken;
      do {
        const r = await client.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
        (r.Contents || []).forEach(o => out.push(o)); ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return out;
    },
    async deletePrefix(Prefix) {
      const objs = await api.list(Prefix); let n = 0;
      for (let i = 0; i < objs.length; i += 1000) {
        const batch = objs.slice(i, i + 1000).map(o => ({ Key: o.Key }));
        if (batch.length) { await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: batch, Quiet: true } })); n += batch.length; }
      }
      return n;
    },
    presignPut(Key, contentType, expiresIn = 3600) {
      return getSignedUrl(client, new PutObjectCommand({ Bucket, Key, ContentType: contentType, ...sse }), { expiresIn });
    },
    presignGet(Key, expiresIn = 300) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), { expiresIn });
    },
  };
  return (cache[name] = api);
}

function need(name) {
  const r = role(name);
  if (!r) throw new Error(`Storage role "${name}" is not configured (set ${name.toUpperCase()}_BUCKET and its keys).`);
  return r;
}

module.exports = { role, need };
