# Amazon S3 go-live for crew uploads — apply steps

The site already speaks S3 (server/crew-s3.js). Moving uploads from
Backblaze B2 to Amazon S3 = one AWS account, one bucket configured by
script, and four env values flipped in Render. No code change at flip
time. Until the flip, the site keeps running on B2 with the rebuilt
uploader (persisted sessions, retries, queue).

## Step 1 — MIGUEL ONLY: create the AWS account (one sitting)

1. Go to aws.amazon.com → "Create an AWS Account".
2. Email: **migueladplus@gmail.com** (standing account rule). Set a
   root password — save it in the Secure Vault, never in chat.
3. Choose account type **Business** (or Personal if it resists),
   contact details: 15507 Furlong Circle, Odessa, FL 33556.
4. Add the payment card when asked; complete the phone/SMS identity
   verification and the support-plan screen (choose **Basic — Free**).
5. Sign in to the Console once as root to confirm the account is live.
6. In the Console, open **IAM → Users → Create user**:
   - Name: `dataismoney-uploader`
   - Check **"Provide user access to the AWS Management Console"** OFF;
     this user is API-only. Create an **access key** for it
     (User → Security credentials → Create access key → "Application
     running outside AWS").
   - Attach policy: **AmazonS3FullAccess** (narrowing to the one
     bucket happens via the bucket policy the setup script applies).
   - Send Jarvis the **Access key ID** and **Secret access key**
     through the Secure Vault — never in chat or email.
7. Also copy the **AWS account ID** (top-right account menu) and the
   user's **ARN** (IAM → Users → dataismoney-uploader, shown at the
   top) — those two are not secrets and can come by chat.

**That is the entire Miguel list.** Everything below is Jarvis-side.

## Step 2 — Jarvis: configure the bucket (script, ~2 minutes)

```bash
AWS_ACCESS_KEY_ID=<from vault> AWS_SECRET_ACCESS_KEY=<from vault> \
S3_BUCKET=dataismoney-crewuploads AWS_REGION=us-east-1 \
S3_APP_USER_ARN=arn:aws:iam::<account-id>:user/dataismoney-uploader \
node ops/setup-s3-bucket.js
```

Creates the bucket and applies: public access fully blocked, AES256
default encryption, **CORS via API** (PUT/GET/HEAD from
https://dataismoney.ai + the Render origin, ETag exposed), lifecycle
abort of stale multipart uploads at 7 days, and a bucket policy that
denies every principal except the app user (presigned URLs carry the
app user's principal, so browser uploads keep working and nothing
else can touch the bucket).

## Step 3 — Jarvis: flip the Render env on the site service

Set (service: the one serving dataismoney.ai):

| Key | Value |
|---|---|
| `S3_ENDPOINT` | `https://s3.us-east-1.amazonaws.com` |
| `S3_BUCKET` | `dataismoney-crewuploads` |
| `S3_KEY_ID` | the IAM access key ID |
| `S3_SECRET` | the IAM secret access key |
| `S3_REGION` | `us-east-1` |

`S3_*` wins over `B2_*` in crew-s3.js, so the B2 values can stay in
place as an instant rollback: delete the `S3_*` vars and redeploy to
return to Backblaze. Save → Render redeploys automatically.

## Step 4 — Jarvis: verify + acceptance batches

1. `GET https://dataismoney.ai/u/health` → enabled, bucket
   `dataismoney-crewuploads`.
2. **20-file batch** through the real page flow (marketing link):
   20/20 complete; every completion's key + ETag recorded from the
   complete response (the server completes from S3's own part list,
   and the session row in Postgres is marked complete with the ETag).
3. **100-photo batch** of small files, same link: 100/100.
4. Spot-check one object with a server-signed GET (HeadObject via
   the transport credentials) to prove presence in the bucket.
5. Only after 2–4 pass: the links go to the team (Miguel's rule —
   new links are tested by us first).

## Notes

- Cost shape: S3 Standard ≈ $0.023/GB-month stored + $0.005 per 1,000
  PUTs; a 1,500-photo batch (~7 GB) costs cents. No egress fees for
  uploads. Miguel's card is only charged by actual usage.
- The DATA seller-data bucket (datapatrimoniostaging on B2) is a
  different store and is NOT part of this move.
- Upload links (/u/<token>) do not change — the token decides the
  folder; the backend behind it is invisible to senders.
