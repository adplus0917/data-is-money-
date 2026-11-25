# DATA Patrimonio: the vault (storage backend)

> **MERGED PACKAGE (Nov 24, 2026).** This is build #2's vault, adopted as the
> base, with the four mandatory merge fixes applied: (1) Object Lock
> COMPLIANCE/10-year default **stripped** — `VAULT_OBJECT_LOCK_MODE=off`,
> Andrew Manie's decision gates any enablement; (2) the `.jet` email fix
> ported from the live site (server + funnel); (3) the signature window
> (six styles or draw-your-own) ported into the funnel; (4) the inherited
> auth-cookie crash fixed (malformed cookie → 401, never 500). Capacity and
> cost figures in §4 are the verified TrueNAS numbers. See
> `vault-merge-report-2026-11-24.md` in the project folder for test evidence.

This covers only **where seller data lives and how it moves**: from the seller's upload to the company's own rack server (the vault), and from there to a view-only data room for buyers. The website itself is described in `README.md`.

---

## 1. The design on one page

```
  SELLER (browser)                         CLOUD                                         VAULT RACK (company-owned, on-site)
  ────────────────                         ─────                                         ──────────────────────────────────
  signs agreement ─► website ─(PUT-only key)─► STAGING bucket  ◄──(pull, outbound only)── INGEST WORKER
  uploads files     (scan + SHA-256          encrypted, auto-deletes     │                 1. SHA-256 + format check + ClamAV
                     for small files)        after 7 days                │                 2. clean → MASTER  ✗ → QUARANTINE
                    large files go ─(1-hour signed URL)─►┘               │                 3. re-read master, hashes must match
                    straight to staging                                  │                 4. ingest record + audit, delete staging
                                                                         │                         │
                                           PostgreSQL (metadata only:    │             ┌───────────▼─────────────┐
                                           folios, file list, hashes,  ◄─┴─────────────│ MASTER STORAGE SERVER   │ dataset vault/master
                                           jobs, sessions, audit log)                  │ dp-master (versioned;   │ own encryption key
                                           Object Lock OFF — gated)  │
                                                 ▲                                     │ dp-quarantine           │ NEVER served to anyone
                                                 │ admin verifies corpus               └───────────┬─────────────┘
  TEAM PANEL ─────────────────────────────────────┤ admin creates engagement                       │ read-only
  (website /admin)                               │ (buyer, folios, redaction, end date)           ▼
                                                 │                                      VIEWING-COPY BUILDER
                                                 └────────── job queue ───────────────► derives ONE copy per engagement,
                                                                                        redacts, writes eng-<id>/ folder
                                                                                                    │
                                                                                        ┌───────────▼─────────────┐
                                                                                        │ VIEWING STORAGE SERVER  │ dataset vault/viewing
                                                                                        │ dp-viewing              │ a DIFFERENT key
                                                                                        └───────────┬─────────────┘
                                                                                                    │ read-only key
  BUYER (browser) ◄── Cloudflare Tunnel (no open ports) ◄── DATA ROOM ─────────────────────────────┘
   sees watermarked page images only                         renders pages, burns in the viewer's identity,
   no download / copy / print                                logs every page, cuts sessions, alerts admins
```

### How the master copy and the viewing copy stay apart

1. **Two storage servers, two disks areas, two keys.** The master copy lives on its own storage server (`minio-master`) on its own encrypted ZFS dataset (`vault/master`). Viewing copies live on a second storage server (`minio-viewing`) on a second dataset (`vault/viewing`) with a **different** encryption key. They are separate pools in every sense: separate processes, separate data folders, separate keys, separate credentials.
2. **The data room cannot reach the master, even on the network.** The data room container is attached only to the viewing network and the tunnel network. There is no network route from the data room to the master server. The data room holds one key: read-only on `dp-viewing`. If it is given any other key, it **refuses to start**.
3. **Only one program reads the master: the builder**, and its master key is read-only (its storage policy explicitly denies writing or deleting master). It copies data out to the viewing server, never back.
4. **The master is write-once by policy, and Object Lock is OFF until a legal decision enables it.** `dp-master` has versioning, and no service key can delete or overwrite master objects (the ingest key is explicitly denied delete; see `ops/minio-policies/`). **Object Lock (WORM retention) ships DISABLED in this merged package** (`VAULT_OBJECT_LOCK_MODE=off` in `ops/setup-buckets.js`): Andrew Manie must decide, in writing, **COMPLIANCE vs GOVERNANCE** before any retention mode is enabled — COMPLIANCE is irreversible once applied, so it is never a setup default. No policy grants `PutObjectRetention` or `BypassGovernanceRetention` to any service.
5. **Viewing copies are per engagement, and they expire.** Each buyer/lab engagement gets its own folder `eng-<id>/`, its own redaction, its own watermark identity and an end date. At the end date (or on revoke) the builder deletes that folder and ends every open session. Deleting a viewing copy never touches the master.
6. **Nothing is viewable before verification.** The builder refuses to build a viewing copy for any folio whose corpus is not marked *verified* by an admin. The team verifies from **stats only** (file types, sizes, row counts, column names, page counts, hashes), never contents.
7. **The database also separates them.** Each service logs in with its own database role (`ops/db-roles.sql`). The data room's role cannot read seller submissions, contact details, file lists or hashes; it sees only viewers, sessions and the manifest of the engagements it serves.

---

## 2. Requirement by requirement

| Requirement | Status | How / where |
|---|---|---|
| Upload never lands on a person's computer; no human touches files | **Met** | Browser → staging bucket → ingest → master, all automatic. Small files (≤ 20 MB) pass through the website's memory (never disk) so they're scanned at the door; large files go straight to staging with a signed URL. |
| Staging is encrypted and short-lived (7 days) | **Met** | Bucket default encryption (R2 encrypts by default) + lifecycle rule "delete after 7 days" (`ops/setup-buckets.js`). Watchdog alerts at day 4 if files are still waiting. |
| Ingest moves staging → vault and deletes staging | **Met** | `vault/ingest-worker.js`. Staging is deleted **only after** the master copy is re-read and its SHA-256 matches. |
| Two copies: master never served; viewing copy derived | **Met** | See section 1. |
| Viewing copy per engagement, with redactions, watermark identity, expiry | **Met, with a limit** | `vault/viewing-builder.js`. Automatic redaction works on CSV, TXT, JSON, IIF, QBO and XLSX (SSNs, card numbers, emails, phones, bank/routing numbers, and any columns you name). **PDFs, images and Word files cannot be redacted reliably by pattern**: when an engagement asks for redaction they are **withheld** and listed in the panel for manual handling, never shown unredacted. |
| Data room view-only: no download, copy, print | **Met** | No route ever returns a file. Pages are rendered server-side to images; the page blocks copy, save, print, drag, right-click and source view. |
| Every page watermarked with the viewer's identity | **Met** | Name, email, buyer, session id and time burned into every image (diagonal tiles + footer), plus a second moving watermark in the browser. |
| Every access logged | **Met** | Every login, page view, failed code, attempt and cut goes to the audit log. |
| Detect copy/download/screen-capture attempts in real time, cut session, alert admins | **Partly possible; built as far as a web page allows** | Detected and cut: copy, print, save, select-all, view-source and devtools shortcuts, the PrintScreen key (when the browser receives it), download URLs, and scraping (too many pages per minute). Window losing focus or tab hidden blanks the content and counts as a warning (10 warnings = cut). Alerts go to Slack/Zapier instantly. **Not detectable by any web page:** a phone camera pointed at the screen, most operating-system capture tools (macOS Cmd-Shift-4 usually never reaches the page), screen-recording software, virtual machines and remote-desktop sessions. The burned-in watermark is the control for those: any leaked image names the viewer and the session, and the audit log shows exactly which pages that session saw. |
| Master and viewing pools separate, separate credentials; data room reads viewing only | **Met** | Two storage servers, two datasets, two keys, per-service storage users (`ops/minio-policies/`), network isolation, start-up refusal, per-service database roles. |
| TLS in transit | **Met with one setup step** | Seller ↔ website, website ↔ staging, rack ↔ staging, rack ↔ database, buyer ↔ data room: all HTTPS/TLS. **Inside the rack**, the containers talk to the two storage servers over private Docker networks; to make that TLS as well, give MinIO an internal certificate (`/root/.minio/certs`), change the endpoints to `https://minio-master:9000` / `https://minio-viewing:9000`, and set `NODE_EXTRA_CA_CERTS` for the workers. |
| Encrypted at rest; keys not on the same machine | **Met with setup** | ZFS native encryption (AES-256-GCM) on `vault/master` and `vault/viewing`, each with its own key fetched at boot from a separate key server (`keylocation=https://…`). If the key server is unreachable, the datasets stay locked: the vault fails closed. Backups are encrypted on the rack before upload; their passwords also come from the key server. |
| S3-compatible storage addressed by bucket/object | **Met** | All code uses S3 APIs only (`vault/lib/s3.js`). Buckets: `dp-staging` (cloud), `dp-master`, `dp-quarantine`, `dp-viewing` (rack). Any S3-compatible store works; MinIO is the reference. Check MinIO's current licence and distribution terms before you buy into it; Garage, SeaweedFS or Ceph RGW are drop-in alternatives because the code only speaks S3. |
| Virus/format scan and SHA-256 per file | **Met** | `vault/lib/scan.js`: one streaming pass computes SHA-256, checks the file's first bytes match its extension, and scans with ClamAV. The website checks small files at upload; the rack re-checks **every** file before master. Three hashes are recorded per file: at upload, in staging, in master, and they must match. |
| Verification gate | **Met** | Corpus status `locked` until an admin clicks **Verify** in the Vault tab. Optional exception: an **internal review** engagement can be allowed before verification by setting `ALLOW_INTERNAL_REVIEW=true` on the builder. It is **off** by default because it contradicts "nothing is viewable before verification"; turn it on only if the team must read content to verify. |
| Append-only audit log, queryable in the admin panel | **Met** | The database refuses UPDATE, DELETE and TRUNCATE on `audit_log`. Each row's hash covers the previous row's hash; **Check log integrity** recomputes the chain. Tested: even a database superuser who disables the protection and edits a row is caught at that exact entry. |
| No secrets in code | **Met** | Everything is in environment files (`ops/env/*.env.example`). Each service gets only its own keys. |

---

## 3. Failure table

| What happens | Effect | What the system does | What you do |
|---|---|---|---|
| **Rack offline during an upload** | Nothing visible to the seller | Uploads land in cloud staging as usual and wait. The website (always on) alerts when any file is > 4 days in staging. | Bring the rack back within 7 days; ingest catches up by itself. |
| Rack offline **more than 7 days** | Staged files expire (by design: staging is short-lived) | Ingest marks them `failed: staging copy expired`, logs it and alerts. | Send the seller a new delivery link from the Vault tab. (Trade-off: raise the lifecycle to 14 days if you'd rather risk longer cloud retention.) |
| Ingest crashes mid-copy | No loss | Staging is deleted only after master is verified; the claim expires after 1 h and the file is retried. | Nothing. |
| Checksum differs between staging and master | No loss | Staging kept, retried in ~5 min, logged as `ingest.checksum_mismatch`. | If it repeats, check disks/network (`zpool status`). |
| Virus or fake file type | Never reaches master | Small files: rejected at upload, never stored. Large files: moved to `dp-quarantine`, alert sent. | Contact the seller; quarantine keeps it 180 days for investigation. |
| **One drive fails** | No data loss, pool degraded | RAIDZ2 keeps serving; ZFS event daemon emails you. | Swap in the cold spare; resilver takes about 1–2 days for 20 TB. |
| Two drives fail at once | No data loss, no redundancy left | Same; still serving. | Replace both immediately, one at a time. |
| Three drives fail / fire / theft | Rack data lost or stolen | Stolen disks are useless without the keys (held off-box). | Restore from the encrypted cloud backup onto new hardware (`ops/rack/backup.sh` in reverse with `rclone copy safe: minio:dp-master`). |
| Key server unreachable at boot | Vault stays locked (fails closed) | Staging buffers uploads for 7 days. | Restore the key server, or unlock from the escrow copy kept in the office safe. |
| **Data room attacked** (server broken into) | Attacker can read the **current viewing copies** (already redacted, per engagement) and viewer names/emails | Master unreachable (no key, no network route); staging and quarantine unreachable; seller contacts unreadable (DB role). Attacker cannot alter audit history. | Revoke all engagements (deletes every viewing copy), rotate the `svc-dataroom` key and DB password, rebuild the container from the image, review `room.*` audit entries. |
| Brute-forcing a viewer's access code | Blocked | 5 wrong codes locks that viewer (alert sent); 10 attempts / 15 min per IP. | Re-invite if legitimate. |
| **A viewing copy leaks** (photo/screenshot posted) | Content of those pages exposed | Every image carries viewer, email, buyer, session and minute; the audit log lists every page that session loaded. | Identify the viewer from the watermark, revoke the engagement, enforce the NDA/engagement contract. The master and other engagements are unaffected. |
| Website (cloud) compromised | Seller contacts in the DB exposed; attacker can write to staging | Cannot read staging, master or viewing (PUT-only key, no others). Anything written to staging is scanned and quarantined before master. | Rotate keys and admin password; restore website from Git. |
| Admin password stolen | Attacker could create an engagement and invite themselves | Every engagement and every invite sends an instant alert; data is watermarked and logged; only *verified* corpora are reachable. | Revoke it from the Vault tab, change `ADMIN_PASSWORD`. Next step: add two-factor sign-in for the team panel. |
| Cloud database lost | Metadata lost (not file contents) | Master objects carry folio, file id and SHA-256 in their metadata, so the catalog can be rebuilt. | Restore from the provider's daily backup. |
| Staging provider outage | Uploads fail for that time | Seller sees an error and can retry. | None. |

---

## 4. Capacity plan — VERIFIED numbers (merged package)

> **Correction applied in the merge (Nov 24, 2026):** the previous edition of
> this section planned 40 → 80 → **160 TB max** (two 6-wide RAIDZ2 vdevs) and
> estimated the starter at **$9,000–$13,000**. Both figures are **superseded —
> do not buy from them.** The verified plan (priced Nov 24, 2026 against the
> iXsystems TrueNAS Mini R; see the rack vendor comparison in the project
> files) is a **single 12-drive RAIDZ2 set**:

**Hardware:** iXsystems **TrueNAS Mini R**, 12 bays, 20 TB enterprise drives, ZFS RAIDZ2 (any two drives can fail), SSD boot/cache, dual 10 GbE.

| Stage | Layout | Drives | Usable | Cost |
|---|---|---|---|---|
| **Start** | 4 × 20 TB in RAIDZ2 | 4 | **~40 TB** (2 data + 2 parity) | **~$5,320 total** (chassis ~$2,000 + 4 × 20 TB drives ~$3,320) |
| **Full box** | Fill all 12 bays — one 12-wide RAIDZ2 set (12 − 2 parity) × 20 TB | 12 | **~200 TB usable** | **+$6,640** (8 more 20 TB drives at ~$830 each), bought only as revenue comes in — no new chassis, no migration |

Honest notes:
- **Plan to use about 80% of usable space.** ZFS slows down when nearly full, so ~40 TB nominal is about 32 TB of comfortable data (and ~200 TB is about 160 TB comfortable).
- Both datasets (`vault/master`, `vault/viewing`) live in the same pool and grow together; their separation comes from different keys, servers and credentials, not different disks.
- Encrypted off-site backup (Backblaze B2, ~$5–10/TB-month, ≈ **$200–$400/month at 40 TB**) is a **separate, unapproved budget decision for Miguel** — priced here for planning only, not included above.
- Cloud staging holds only ~7 days of uploads at a time: a few dollars a month.

When to grow: add drives when the pool passes **70%** full. Beyond ~200 TB, add a second chassis (JBOD shelf) as another vdev, or a second rack.

---

## 5. Setting it up, step by step

### A. Cloud staging (30 minutes)
1. Create a Cloudflare R2 (or AWS S3) bucket `dp-staging`.
2. Create two keys as described in `ops/minio-policies/staging-cloud.md`: `web-put` (website) and `ingest-pull` (rack).
3. With your account's admin keys: `PUBLIC_URL=https://yourdomain.com node ops/setup-buckets.js staging` (sets encryption, the 7-day delete rule and browser upload permission).
4. Add the `STAGING_*` settings from `ops/env/web.env.example` to the website on Render. The website now shows a **Vault** tab in the team panel.

### B. The rack (one day)
1. Install TrueNAS SCALE or Ubuntu with OpenZFS 2.3+. Create the pool (section 4) and two encrypted datasets, each with its own key on the key server:
   ```
   zfs create -o encryption=aes-256-gcm -o keyformat=raw -o keylocation=https://keys.internal/master.key vault/master
   zfs create -o encryption=aes-256-gcm -o keyformat=raw -o keylocation=https://keys.internal/viewing.key vault/viewing
   ```
   (The key server is a separate small machine or a cloud key service, reachable only from the rack. Keep a paper/hardware escrow copy of both keys in the safe.)
2. Install Docker. Copy this repository to the rack. Create `ops/env/ingest.env`, `builder.env`, `dataroom.env` from the `.example` files.
3. `docker compose -f ops/rack/docker-compose.yml up -d minio-master minio-viewing clamav`
4. Buckets and service users:
   ```
   MASTER_BUCKET=dp-master MASTER_S3_ENDPOINT=http://127.0.0.1:9000 MASTER_ACCESS_KEY_ID=<root> MASTER_SECRET_ACCESS_KEY=<root> \
   QUARANTINE_BUCKET=dp-quarantine QUARANTINE_S3_ENDPOINT=http://127.0.0.1:9000 QUARANTINE_ACCESS_KEY_ID=<root> QUARANTINE_SECRET_ACCESS_KEY=<root> \
   VIEWING_BUCKET=dp-viewing VIEWING_S3_ENDPOINT=http://127.0.0.1:9002 VIEWING_ACCESS_KEY_ID=<root> VIEWING_SECRET_ACCESS_KEY=<root> \
   node ops/setup-buckets.js master quarantine viewing
   ops/rack/minio-users.sh        # prints one secret per service: paste into the env files
   ```
5. Database roles: run `ops/db-roles.sql` once against the website's database (change the passwords), and give each rack service its own `DATABASE_URL`.
6. Data room address: create a Cloudflare Tunnel for `room.yourdomain.com` → `http://dataroom:4000`, put its token in `CLOUDFLARE_TUNNEL_TOKEN`, set `DATAROOM_URL=https://room.yourdomain.com` on the website.
7. `docker compose -f ops/rack/docker-compose.yml up -d` (starts ingest, builder, data room, tunnel).
8. Nightly encrypted backup: schedule `ops/rack/backup.sh` (rclone crypt → Backblaze B2).

### C. Daily use (team panel → Vault tab)
1. A seller uploads → files appear under **Corpora** with scan result, hashes and stats.
2. Team checks the stats against the signed manifest → **Verify** (or **Reject**).
3. **New engagement**: buyer, folios, redaction (default: remove personal data), end date → the viewing copy builds itself. Anything that couldn't be redacted is listed as *withheld*.
4. **Invite viewer** → the panel shows a link and an access code **once**. Send them through two different channels.
5. Watch **Data-room sessions**; **Cut** any session by hand. **Revoke** ends the engagement and deletes its viewing copy.
6. **Audit log**: filter by folio or action; **Check log integrity** proves nothing was edited.
7. To get the full data from a seller: **Delivery link for folio** → send the link; files go straight to staging and through the same pipeline.

---

## 6. Files

| File | What it is |
|---|---|
| `vault/lib/s3.js` | Storage by role; each process only gets the buckets it's allowed |
| `vault/lib/scan.js` | Streaming SHA-256 + format check + ClamAV |
| `vault/lib/audit.js` | Audit insert/query/integrity check, alerts |
| `vault/lib/jobs.js` | Job queue on PostgreSQL |
| `vault/lib/redact.js` | Redaction rules; XLSX → CSV |
| `vault/ingest-worker.js` | Staging → master / quarantine |
| `vault/viewing-builder.js` | Viewing copies, verification gate, expiry/revoke |
| `vault/dataroom/` | The data room server and viewer page |
| `server/vault-routes.js` | Website side: uploads to staging, Vault admin API, watchdog |
| `public/deliver.html`, `public/admin-vault.js` | Seller delivery page; Vault tab in the team panel |
| `server/schema.sql` | Vault tables + append-only audit trigger (bottom half) |
| `ops/` | Bucket setup, storage policies, rack compose file, env examples, DB roles, backup |
| `tests/vault/` | End-to-end test (39 checks) |
| `Dockerfile` | One image for all four services |
