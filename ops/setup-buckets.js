// One-time bucket setup. Run with ADMIN keys (not the service keys), e.g.
//   cloud staging:  STAGING_* = admin keys of your cloud account   → node ops/setup-buckets.js staging
//   vault rack:     MASTER_/VIEWING_/QUARANTINE_* = MinIO root keys → node ops/setup-buckets.js master viewing quarantine
// What it sets:
//   staging    : default encryption, delete everything after 7 days, CORS so browsers can PUT from your site
//   master     : versioning only. NO Object Lock is applied by this script by default (see the gate below).
//   viewing    : delete-after backstop (400 days) in case an engagement is never closed
//   quarantine : default encryption, kept 180 days for investigation
//
// ============================================================================
// OBJECT LOCK GATE — READ BEFORE ENABLING ANYTHING (merged-package rule)
// VAULT_OBJECT_LOCK_MODE defaults to "off": this script creates the master
// bucket WITHOUT Object Lock and applies NO retention rule, and no service
// policy in ops/minio-policies/ grants PutObjectRetention or
// BypassGovernanceRetention to anyone.
//
// Object Lock mode is a LEGAL decision, not a setup default: Andrew Manie
// must decide, in writing, COMPLIANCE vs GOVERNANCE before any mode is
// enabled. WARNING: COMPLIANCE mode is IRREVERSIBLE — once a retention rule
// is applied, no one (not even the account root) can delete the objects or
// shorten the retention before it expires, so a court order or contract
// requiring deletion could not be executed. An earlier version of this
// script pre-enabled COMPLIANCE with a 3,650-day (10-year) default; that
// default has been REMOVED and must never be restored as a default.
//
// To enable a mode AFTER Andrew's written decision, an operator must set
// BOTH of these explicitly (the script refuses otherwise):
//   VAULT_OBJECT_LOCK_MODE=governance|compliance
//   VAULT_OBJECT_LOCK_CONFIRMED=ANDREW_DECISION_ON_FILE
//   MASTER_RETENTION_DAYS=<days Andrew approved>   (no default)
// Note: enabling Object Lock on a bucket that was created without it is not
// possible on S3/MinIO — the master bucket must be re-created with
// ObjectLockEnabledForBucket at that point (before any seller data lands).
// ============================================================================
const s3 = require("../vault/lib/s3");
const C = require("@aws-sdk/client-s3");

const LOCK_MODE = String(process.env.VAULT_OBJECT_LOCK_MODE || "off").toLowerCase();
const LOCK_CONFIRMED = process.env.VAULT_OBJECT_LOCK_CONFIRMED === "ANDREW_DECISION_ON_FILE";

function lockGate() {
  if (LOCK_MODE === "off") return null;
  if (!["governance", "compliance"].includes(LOCK_MODE))
    throw new Error(`VAULT_OBJECT_LOCK_MODE must be off|governance|compliance, got "${LOCK_MODE}"`);
  if (!LOCK_CONFIRMED)
    throw new Error("Object Lock gate: VAULT_OBJECT_LOCK_MODE is set but Andrew Manie's COMPLIANCE-vs-GOVERNANCE decision is not confirmed (set VAULT_OBJECT_LOCK_CONFIRMED=ANDREW_DECISION_ON_FILE only with his written decision on file). Refusing to apply any retention.");
  const days = Number(process.env.MASTER_RETENTION_DAYS);
  if (!Number.isInteger(days) || days <= 0)
    throw new Error("Object Lock gate: MASTER_RETENTION_DAYS must be set explicitly to the retention Andrew approved (there is deliberately no default).");
  return { mode: LOCK_MODE.toUpperCase(), days };
}

async function step(label, fn) {
  try { await fn(); console.log("  ✓", label); }
  catch (e) { console.log("  !", label, "→", e.name || e.message, "(set it by hand if your storage doesn't support it)"); }
}

async function setup(name) {
  const r = s3.need(name), Bucket = r.bucket, send = c => r.client.send(c);
  console.log(`${name} → ${Bucket}`);
  const lock = name === "master" ? lockGate() : null;   // throws before touching storage if the gate fails
  await step("create bucket" + (name === "master" && lock ? " with object lock (Andrew-gated)" : ""), async () => {
    try { await send(new C.HeadBucketCommand({ Bucket })); console.log("    (already exists)"); }
    catch { await send(new C.CreateBucketCommand({ Bucket, ...(name === "master" && lock ? { ObjectLockEnabledForBucket: true } : {}) })); }
  });
  await step("default encryption", () => send(new C.PutBucketEncryptionCommand({ Bucket, ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: process.env[name.toUpperCase() + "_SSE"] || "AES256" } }] } })));
  await step("block public access", () => send(new C.PutPublicAccessBlockCommand({ Bucket, PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } })));
  const expire = { staging: 7, viewing: 400, quarantine: 180 }[name];
  if (expire) await step(`lifecycle: delete after ${expire} days`, () => send(new C.PutBucketLifecycleConfigurationCommand({ Bucket, LifecycleConfiguration: { Rules: [{ ID: `expire-${expire}d`, Status: "Enabled", Filter: { Prefix: "" }, Expiration: { Days: expire }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }] } })));
  if (name === "master") {
    await step("versioning", () => send(new C.PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: "Enabled" } })));
    if (lock) {
      await step(`object lock: ${lock.mode} ${lock.days} days (Andrew Manie decision on file)`, () => send(new C.PutObjectLockConfigurationCommand({ Bucket, ObjectLockConfiguration: { ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: lock.mode, Days: lock.days } } } })));
    } else {
      console.log("  • object lock: OFF (VAULT_OBJECT_LOCK_MODE=off) — no retention applied. Andrew Manie must decide COMPLIANCE vs GOVERNANCE before this is enabled; see the gate note at the top of this file.");
    }
  }
  if (name === "staging") {
    const origins = (process.env.PUBLIC_URL || "http://localhost:3000").split(",").map(s => s.trim());
    await step("CORS for " + origins.join(", "), () => send(new C.PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: [{ AllowedOrigins: origins, AllowedMethods: ["PUT"], AllowedHeaders: ["content-type"], MaxAgeSeconds: 3600 }] } })));
  }
}

(async () => {
  const names = process.argv.slice(2);
  if (!names.length) { console.log("usage: node ops/setup-buckets.js staging | master viewing quarantine"); process.exit(1); }
  for (const n of names) await setup(n);
})().catch(e => { console.error(e.message); process.exit(1); });
