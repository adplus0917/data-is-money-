# Vault end-to-end test

Runs the whole pipeline on one machine with stand-ins: an S3 test server (instead of R2/MinIO),
a fake ClamAV that flags the standard EICAR test string, and a local PostgreSQL.

```
cd tests/vault && npm i s3rver@3 --no-save && node make-files.js
node s3.js &            # S3 test server on :4568
node fakeclamd.js &     # fake virus scanner on :3310
# PostgreSQL on :5433 with database dp2 (see env.sh), then from the repo root:
. tests/vault/env.sh; st; ma; vi; qu; node ops/setup-buckets.js staging master viewing quarantine
. tests/vault/env.sh; st; ADMIN_PASSWORD=test-password-123 PORT=3100 CLAMD_HOST=localhost DATAROOM_URL=http://localhost:4100 node server/index.js &
psql -h localhost -p 5433 -U postgres dp2 -f ops/db-roles.sql
. tests/vault/env.sh; vi; DATABASE_URL=postgres://dp_dataroom@localhost:5433/dp2 DATAROOM_PORT=4100 DATAROOM_MAX_PAGES_PER_MIN=12 node vault/dataroom/server.js &
node tests/vault/e2e.js
```
Run it on a fresh database: the test deliberately tampers with one audit entry at the end to prove the integrity check catches it.

What it checks (39 checks): virus and fake-format files rejected at the website; direct large uploads; ingest
hashes (upload = staging = master); quarantine; staging emptied; corpus locked until verified; viewing copy blocked
before verification; redaction of SSN/card/email/phone/columns; master untouched; separate per-engagement folders;
invite + access code; watermarked page images; no download route; copy attempt and scraping cut the session;
expiry and revoke delete the viewing copy but never the master; audit log append-only and tamper-evident.
