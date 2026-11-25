# DATA Patrimonio: seller website, step by step

This folder is the complete website: the seller funnel, the valuation engine, the two-page agreement, folio numbers, sample uploads, feedback, and the password-protected team panel. It runs on one small server with a PostgreSQL database.

> **The vault (where seller data is stored, the buyer data room) is documented in [`VAULT.md`](VAULT.md).** Without the vault settings the site runs exactly as described below, with samples saved on the server's private disk. Add the staging-bucket settings and uploads switch to the vault pipeline automatically.

This guide covers three things:

1. **How the pieces fit together** (what each file does and how a seller's answers travel through the system).
2. **How to run it on your computer** to try it.
3. **How to put it online** at your own domain, step by step.

---

## 1. How it all fits together

```
 SELLER'S PHONE / BROWSER                     YOUR SERVER (Node.js)                          STORAGE
 ─────────────────────────                    ─────────────────────                          ───────
 index.html  ── loads ──►  engine.js  (prices, shows the estimate instantly)
             ── loads ──►  i18n.js    (every word, English + Spanish)
             ── loads ──►  app.js     (the 6 steps)
                                   │
   Step 5 "Sign and submit" ───────┼── POST /api/submissions ──► server/index.js
                                   │                              ├─ options.js  checks every answer is a real option
                                   │                              ├─ engine.js   RECOMPUTES the price (browser is never trusted)
                                   │                              └─ db.js ──────────────────────────────► PostgreSQL
                                   │                                  takes the next folio + saves the row      submissions
                                   │                                  in ONE transaction (no duplicate folios)  folio_counters
                                   │◄── folio DP-2026-0001 + private upload token ──┘                           status_history
                                   │
   Step 6 sample upload ───────────┼── POST /api/submissions/:folio/samples ──► storage.js ─────────────► private disk
                                   │      (needs the private token)              random file name           (never public)
                                   │                                             db.js links file to folio ► sample_files
   Feedback box (every step) ──────┴── POST /api/feedback ─────────────────────► db.js ─────────────────► feedback

 TEAM PANEL  /admin
 ──────────────────
 admin.html + admin.js ── POST /api/admin/login (password) ──► auth.js sets a signed 12-hour cookie
                        ── GET  /api/admin/submissions, /feedback  (every 30 s, "live")
                        ── PATCH /api/admin/submissions/:folio   (status change, logged in status_history)
                        ── GET  /api/admin/export.csv | .json    (download everything)
                        ── GET  /api/admin/samples/:id           (download a seller's sample)

 Optional: every new submission also POSTs a message to NOTIFY_WEBHOOK_URL (Slack, Zapier, Make).
```

### What each file does

| File | What it is | When you'd touch it |
|---|---|---|
| `server/engine.js` | **The valuation engine** (02-valuation-engine.js, exact). Used by the browser *and* the server. | To change prices: edit `CONFIG`, restart. |
| `public/i18n.js` | **Every word on the site**, English and Spanish, plus the draft agreement (`AG`). | To change wording, add a sector, update the agreement. |
| `public/index.html` | The seller page skeleton (header, hero, funnel, explainer, market section). | Rarely. |
| `public/app.js` | The 6-step funnel: shows screens, checks answers, sends to the server. | Rarely. |
| `public/admin.html`, `public/admin.js` | Team panel: sign-in, submissions, statuses, feedback, engine validation, exports. | Rarely. |
| `public/styles.css` | Look and feel (navy, gold, lion). | To restyle. |
| `server/index.js` | The web server and every API route, security headers, rate limits, webhook alert. | To add a feature. |
| `server/options.js` | The list of allowed answers. The server rejects anything else. | When you add a sector or option in `i18n.js`, add its code here too. |
| `server/db.js` | **The only file that talks to the database.** PostgreSQL in production; a JSON file when testing with no database. | To move to another database. |
| `server/schema.sql` | Database tables (follows 03-data-model.md). Runs automatically at start-up. | To add a column. |
| `server/storage.js` | Saves sample files privately with random names; allowed file types; size limit. | To move samples to S3 / Cloudflare R2. |
| `server/auth.js` | Team-panel password check and signed cookie. | Rarely. |
| `scripts/validate-engine.js` | Runs the kit's 4 test companies through the engine. | After any price change: `npm run validate`. |
| `render.yaml` | One-click setup on Render (server + database + private disk). | Rarely. |
| `.env.example` | The settings the server needs. | Copy to `.env` locally. |
| `server/vault-routes.js`, `vault/`, `ops/`, `public/deliver.*`, `public/admin-vault.js` | The vault: staging uploads, ingest to the rack, viewing copies, data room, Vault tab. | See `VAULT.md`. |
| `Dockerfile` | One image for the website and the three rack services. | Rarely. |

### Key rules the code enforces

- **The server's price is the one saved.** The browser shows the estimate instantly, but on submit the server recomputes it with the same `engine.js`. Nobody can edit the page to give themselves a higher price.
- **Folios never repeat.** The next number is taken inside a database transaction. Tested with 15 sellers signing at the same instant: 15 unique folios.
- **Every answer is checked.** Unknown sectors, missing manifest items, a bad email: rejected with a clear error.
- **Samples are private.** They're saved outside the public folder with random names. Only someone signed in to the team panel can download them. Each seller gets a private upload token that works only for their own folio.
- **Team panel is password protected.** Wrong passwords are slowed down (8 tries a minute). The sign-in cookie can't be read by scripts or sent from other sites.
- **Estimates are always labeled preliminary**, and the agreement is marked DRAFT/BORRADOR until your lawyer approves it.

---

## 2. Run it on your computer (about 10 minutes)

**You need:** Node.js 20 or newer (download from nodejs.org, the "LTS" button).

1. **Unzip** this folder somewhere, e.g. `Documents/data-patrimonio`.
2. **Open a terminal in that folder.**
   - Mac: open Terminal, type `cd ` (with a space), drag the folder into the window, press Enter.
   - Windows: open the folder, click the address bar, type `cmd`, press Enter.
3. **Install the three building blocks** (Express, Multer, pg):
   ```
   npm install
   ```
4. **Set a password for the team panel** and start the server:
   - Mac / Linux:
     ```
     ADMIN_PASSWORD=pick-a-long-password npm start
     ```
   - Windows (Command Prompt):
     ```
     set ADMIN_PASSWORD=pick-a-long-password
     npm start
     ```
   You'll see: `DATA Patrimonio running on http://localhost:3000 (database: json-file)`.
5. **Open http://localhost:3000** and go through the six steps as a seller.
6. **Open http://localhost:3000/admin**, sign in with your password, and see the submission, change its status, download the CSV.
7. **Check the engine:** `npm run validate` prints the four kit profiles with the math.

Locally, with no database set, everything is saved in a `data/` folder (`data/db.json` and `data/uploads/`). That's only for trying it. The live site uses PostgreSQL.

---

## 3. Put it online (Render, about 30–45 minutes)

Render is a hosting company that runs the server, the PostgreSQL database and a private disk for samples, all from the `render.yaml` file in this folder. (Railway, Fly.io or any VPS also work: you need Node 20+, PostgreSQL and a persistent folder for uploads.)

### Step 1: Put the code on GitHub
1. Create a free account at github.com.
2. Click **New repository** → name it `data-patrimonio` → **Private** → Create.
3. On the new repository page click **uploading an existing file**, drag in everything from this folder **except** `node_modules` and `data`, and click **Commit changes**.

### Step 2: Create everything on Render
1. Create an account at render.com and connect your GitHub.
2. Click **New → Blueprint**, pick the `data-patrimonio` repository.
3. Render reads `render.yaml` and shows: a web service, a PostgreSQL database and a 10 GB disk. It asks for two values:
   - `ADMIN_PASSWORD`: the team-panel password, **at least 12 characters**. Share it only with your team.
   - `NOTIFY_WEBHOOK_URL`: optional, leave blank for now (see step 5).
4. Click **Apply**. In a few minutes you get an address like `https://data-patrimonio.onrender.com`.
5. Open it and go through the funnel once, then open `/admin` and sign in.

`SESSION_SECRET` is generated automatically; `DATABASE_URL` is connected automatically. The server refuses to start in production if the password, secret or database is missing, so it can't go live unprotected by accident.

**Cost (check Render's current pricing):** the persistent disk needs a paid web-service plan ("Starter"), plus a small paid database. Roughly $15–$30 a month to start.

### Step 3: Connect your domain
1. In Render, open the web service → **Settings → Custom Domains → Add**, type e.g. `datapatrimonio.com` and `www.datapatrimonio.com`.
2. Render shows DNS records (a CNAME and/or A record). Add them at your domain registrar (GoDaddy, Namecheap, Google Domains, Cloudflare…).
3. Wait 10 minutes to a few hours. Render issues the HTTPS certificate automatically.

### Step 4: Backups
- Render's paid PostgreSQL plans take daily backups. Turn them on in the database's settings.
- Once a week, download **CSV** and **JSON** from the team panel and keep them in your company Drive.
- Samples live on the Render disk. Render snapshots disks daily; when volume grows, move samples to Amazon S3 or Cloudflare R2 (only `server/storage.js` changes).

### Step 5 (optional): Instant alert on every new seller
1. In Slack: **Apps → Incoming Webhooks → Add**, choose a channel, copy the webhook URL. (Or create a Zapier/Make "Catch Hook" and copy its URL to send email or SMS.)
2. In Render → web service → **Environment**, set `NOTIFY_WEBHOOK_URL` to that URL. Save (the service restarts).
3. Each new submission posts: folio, company, owner, track, range and tier.

---

## 4. Daily use

- **Team panel:** `https://yourdomain.com/admin`. It refreshes every 30 seconds.
- **Move a deal forward:** change the **Status** drop-down. Every change is recorded with a time in `status_history`.
  `Nuevo → Contactado → Papel enviado → Firmado → Muestra recibida → Verificado → Pagado → En el vault`
  (When a seller uploads a sample, a `Nuevo` deal moves to `Muestra recibida` by itself.)
- **Samples:** click the file name in the Sample column to download it.
- **Feedback:** the Feedback tab shows every comment, which step it came from, and the folio if the seller had one.
- **Exports:** Download CSV (submissions), CSV · Feedback, Download JSON (everything).

---

## 5. How to change things

| You want to… | Do this |
|---|---|
| Change prices or tiers | Edit `CONFIG` in `server/engine.js`, run `npm run validate`, push to GitHub. Render redeploys by itself. |
| Change any wording | Edit `public/i18n.js` (English in `T.en`, Spanish in `T.es`). |
| Replace the draft agreement with the lawyer's version | Edit `AG` in `public/i18n.js` and remove the DRAFT/BORRADOR badge in `public/app.js` (search `draft`). |
| Add a sector | Add a line to `O.sector` in `public/i18n.js` **and** its code to `SECTORS` in `server/options.js`. |
| Allow more file types or bigger samples | `ALLOWED` in `server/storage.js`; `MAX_UPLOAD_MB` setting. |
| Change the team password | Render → Environment → `ADMIN_PASSWORD` → Save. |

Pushing a change: edit the file on GitHub (pencil icon) → **Commit**. Render deploys the new version in 1–3 minutes.

---

## 6. Before you open it to the public

1. **Engine check.** `npm run validate` shows profiles A and D outside the kit's expected ranges (A is low: the $2–5M base gives about $18K–$20K against $21K–$49K; D is high: the single "over $20M" band gives $543K against $275K–$450K). Decide whether to adjust `revenueBase` or add a $20–50M band, then re-run.
2. **Lawyer.** Final two-page agreement, plus a **privacy policy** and **terms of use** page (the site collects names, emails, phones and business files).
3. **E-signature.** The typed-name signature records intent; send the executed copy by DocuSign as the agreement says.
4. **Spanish review** by a native speaker of your target market.
5. **Test from a phone** on mobile data, start to finish, in both languages.

---

## 7. API reference

| Method & path | Who | Body / headers | Returns |
|---|---|---|---|
| `POST /api/valuation` | anyone | `{answers}` | engine result |
| `POST /api/submissions` | anyone | `{answers, contact, manifest:[5×true], lang}` | `{folio, valuation, uploadToken}` |
| `POST /api/submissions/:folio/samples` | seller | header `X-Upload-Token`, multipart `files` (≤10, ≤20 MB) | `{saved:[…]}` |
| `POST /api/feedback` | anyone | `{step:1–6, comment, folio?, lang}` | `{ok}` |
| `POST /api/admin/login` / `logout` | team | `{password}` | sets / clears cookie |
| `GET /api/admin/submissions` / `feedback` | team | | lists |
| `PATCH /api/admin/submissions/:folio` | team | `{status}` | `{ok}` |
| `GET /api/admin/samples/:id` | team | | the file |
| `GET /api/admin/export.csv[?table=feedback]` / `export.json` | team | | download |
| `GET /health` | anyone | | `{ok, db, engine}` |

Answer codes (`answers`): `sector` (gc, stucco, paint, roof, elec, plumb, hvac, remodel, realestate, mfg, transport, health, legal, accounting, restaurant, retail, services, tech, agri, other) · `years_in_business` / `record_years` (under3, 3to5, 5to10, over10) · `employees` (1to10, 11to25, 26to50, 51to75, over75) · `data_types` (invoices, quotes, contracts, drawings, email, photos, accounting) · `record_volume` (under1k, 1kto10k, 10kto50k, over50k) · `revenue_band` (under2m, 2to5m, 5to10m, 10to20m, over20m) · `format` (digital_structured, mixed, paper_scans) · `frequency` (ongoing, static) · `track` (compra_directa, licencia).

---

## 8. Troubleshooting

| Problem | Fix |
|---|---|
| `Set ADMIN_PASSWORD (12+ characters) before going live.` | Add the setting in Render → Environment. |
| Team panel says wrong password after several tries | Wait one minute (rate limit). |
| Sample upload says "upload link not valid" | The seller refreshed into a new session. Ask them to email the file, or re-send from the same browser tab. |
| Site loads but fonts look plain | Google Fonts blocked on that network. The site still works. |
| `npm install` fails | Check `node -v` shows 20 or higher. |
