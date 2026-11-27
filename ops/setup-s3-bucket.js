'use strict';
// ============================================================
// Amazon S3 bucket setup for crew uploads — run ONCE after the
// AWS account + IAM user exist (see ops/S3-GO-LIVE.md).
//
//   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
//   S3_BUCKET=dataismoney-crewuploads AWS_REGION=us-east-1 \
//   S3_APP_USER_ARN=arn:aws:iam::<acct>:user/dataismoney-uploader \
//   node ops/setup-s3-bucket.js
//
// Applies, via the S3 API (no console archaeology):
//   1. CreateBucket (private by default; us-east-1 has no
//      LocationConstraint, every other region gets one).
//   2. Block Public Access — all four switches ON.
//   3. Default server-side encryption (AES256).
//   4. CORS: PUT/GET/HEAD from the site origins, ETag exposed —
//      this is the setting whose ABSENCE on Backblaze caused the
//      Nov 27 mass-upload collapse; here it is one API call.
//   5. Lifecycle: abort incomplete multipart uploads after 7 days
//      (stale sessions never accumulate storage charges).
//   6. Bucket policy (only when S3_APP_USER_ARN is set): Deny
//      every principal EXCEPT the app user — so the bucket is
//      reachable only through the server's credentials and the
//      presigned URLs it issues (a presigned request carries the
//      app user's principal, so uploads keep working).
// Idempotent: re-running re-applies the same configuration.
// ============================================================
const {
  S3Client, CreateBucketCommand, PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand, PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand, PutBucketPolicyCommand,
  HeadBucketCommand,
} = require('@aws-sdk/client-s3');

const REGION = process.env.AWS_REGION || process.env.S3_REGION || 'us-east-1';
const BUCKET = process.env.S3_BUCKET || 'dataismoney-crewuploads';
const APP_USER_ARN = process.env.S3_APP_USER_ARN || '';
const ROOT_ARN = process.env.S3_ROOT_ARN || ''; // optional: also allow the account root principal
const ORIGINS = (process.env.SITE_ORIGINS || 'https://dataismoney.ai,https://data-patrimonio.onrender.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

const s3 = new S3Client({ region: REGION });

async function main() {
  console.log(`Bucket: ${BUCKET}  Region: ${REGION}  Origins: ${ORIGINS.join(', ')}`);

  // 1. Create (tolerate already-owned)
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    console.log('1/6 bucket exists — keeping it');
  } catch {
    await s3.send(new CreateBucketCommand({
      Bucket: BUCKET,
      ...(REGION === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: REGION } }),
    }));
    console.log('1/6 bucket created');
  }

  // 2. Block all public access
  await s3.send(new PutPublicAccessBlockCommand({
    Bucket: BUCKET,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, IgnorePublicAcls: true,
      BlockPublicPolicy: true, RestrictPublicBuckets: true,
    },
  }));
  console.log('2/6 public access blocked');

  // 3. Default encryption
  await s3.send(new PutBucketEncryptionCommand({
    Bucket: BUCKET,
    ServerSideEncryptionConfiguration: {
      Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: true }],
    },
  }));
  console.log('3/6 default encryption on (AES256)');

  // 4. CORS — direct browser uploads from the site only
  await s3.send(new PutBucketCorsCommand({
    Bucket: BUCKET,
    CORSConfiguration: {
      CORSRules: [{
        AllowedOrigins: ORIGINS,
        AllowedMethods: ['PUT', 'GET', 'HEAD'],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['ETag'],
        MaxAgeSeconds: 3600,
      }],
    },
  }));
  console.log('4/6 CORS applied (PUT/GET/HEAD from the site origins, ETag exposed)');

  // 5. Lifecycle — abort stale multipart uploads at 7 days
  await s3.send(new PutBucketLifecycleConfigurationCommand({
    Bucket: BUCKET,
    LifecycleConfiguration: {
      Rules: [{
        ID: 'abort-stale-multipart-7d',
        Status: 'Enabled',
        Filter: { Prefix: '' },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
      }],
    },
  }));
  console.log('5/6 lifecycle: stale multipart uploads abort after 7 days');

  // 6. Bucket policy — presigned/server access only
  if (APP_USER_ARN) {
    const allowed = [APP_USER_ARN, ...(ROOT_ARN ? [ROOT_ARN] : [])];
    const policy = {
      Version: '2012-10-17',
      Statement: [{
        Sid: 'DenyEveryoneExceptAppUser',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:*',
        Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`],
        Condition: { StringNotEquals: { 'aws:PrincipalArn': allowed } },
      }],
    };
    await s3.send(new PutBucketPolicyCommand({ Bucket: BUCKET, Policy: JSON.stringify(policy) }));
    console.log('6/6 bucket policy applied (deny all except the app user)');
  } else {
    console.log('6/6 SKIPPED bucket policy — set S3_APP_USER_ARN and re-run to lock the bucket to presigned/server access');
  }

  console.log('\nDone. Next: set the Render env (see ops/S3-GO-LIVE.md) and redeploy.');
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
