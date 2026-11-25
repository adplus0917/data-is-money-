# Staging bucket keys (cloud: Cloudflare R2 or AWS S3)

Create TWO keys on the staging bucket only:

| Key | Used by | Permissions |
|---|---|---|
| `web-put` | website (cloud) | **Object Write only** on `dp-staging` (R2: "Object Read & Write" scoped to the one bucket is the narrowest R2 offers; on AWS use the JSON below) |
| `ingest-pull` | ingest worker (vault rack) | Object Read + Delete on `dp-staging` |

AWS IAM policy for `web-put`:
```json
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Action": ["s3:PutObject"], "Resource": ["arn:aws:s3:::dp-staging/*"] } ] }
```
AWS IAM policy for `ingest-pull`:
```json
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Action": ["s3:GetObject", "s3:DeleteObject"], "Resource": ["arn:aws:s3:::dp-staging/*"] },
  { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": ["arn:aws:s3:::dp-staging"] } ] }
```
Note for R2: R2 API tokens cannot be write-only. If the website's key must not be able to read staging, use AWS S3 for staging, or accept that the website key can read the last 7 days of staging.
