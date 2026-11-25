-- DATA Patrimonio — database schema (follows 03-data-model.md)
-- Safe to run more than once.

-- One row per year; the folio number is taken from here inside a transaction,
-- so two sellers signing at the same moment can never get the same folio.
CREATE TABLE IF NOT EXISTS folio_counters (
  year integer PRIMARY KEY,
  n    integer NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id                 bigserial PRIMARY KEY,
  folio              text UNIQUE NOT NULL,              -- DP-2026-0001
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- step 1
  sector             text NOT NULL,
  years_in_business  text NOT NULL,
  employees          text NOT NULL,
  -- step 2
  record_years       text NOT NULL,
  data_types         text[] NOT NULL,
  record_volume      text NOT NULL,
  -- step 3
  revenue_band       text NOT NULL,
  format             text NOT NULL,
  frequency          text NOT NULL CHECK (frequency IN ('ongoing','static')),
  track              text NOT NULL CHECK (track IN ('compra_directa','licencia')),
  -- step 4 (computed by the SERVER with server/engine.js)
  estimate_low       integer NOT NULL,
  estimate_high      integer NOT NULL,
  estimate_point     integer NOT NULL,
  tier               text NOT NULL,
  score              integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  breakdown          jsonb NOT NULL,
  engine_version     text,
  -- step 5
  company_name       text NOT NULL,
  owner_name         text NOT NULL,
  email              text,
  phone              text,
  manifest_confirmed boolean NOT NULL DEFAULT false,
  signature_name     text NOT NULL,
  signature_method   text NOT NULL DEFAULT 'typed',
  signature_style    text,
  signature_data     text,
  signed_at          timestamptz NOT NULL,
  lang               text,
  -- step 6
  sample_file_ref    text,                               -- ids of stored samples, comma-separated
  upload_token_hash  text,                               -- sha256 of the seller's private upload token
  status             text NOT NULL DEFAULT 'Nuevo' CHECK (status IN
                     ('Nuevo','Contactado','Papel enviado','Firmado','Muestra recibida','Verificado','Pagado','En el vault'))
);
CREATE INDEX IF NOT EXISTS submissions_created_idx ON submissions (created_at DESC);

-- Each uploaded sample file (the file itself lives in private storage, never in a public folder)
CREATE TABLE IF NOT EXISTS sample_files (
  id            bigserial PRIMARY KEY,
  folio         text NOT NULL REFERENCES submissions(folio) ON DELETE CASCADE,
  stored_name   text NOT NULL,
  original_name text NOT NULL,
  size_bytes    integer NOT NULL,
  mime          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feedback (
  id         bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  step       text NOT NULL,          -- 1–6, which funnel step the comment came from
  folio      text,                   -- null if the seller has no folio yet
  comment    text NOT NULL,
  lang       text
);
CREATE INDEX IF NOT EXISTS feedback_created_idx ON feedback (created_at DESC);

-- Live chat (soft launch): every visitor/bot exchange is logged so the team
-- can read what people asked. Sessions group the messages of one visitor.
CREATE TABLE IF NOT EXISTS chat_sessions (
  id         bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  lang       text,
  ip         text
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         bigserial PRIMARY KEY,
  session_id bigint NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  role       text NOT NULL CHECK (role IN ('visitor','bot')),
  topic      text,                   -- knowledge-base topic the bot answered (bot rows)
  text       text NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_session_idx ON chat_messages (session_id, id);

-- "Send by email" form inside the chat (and the Contact window):
-- a message from a visitor with the email the team replies to.
CREATE TABLE IF NOT EXISTS contact_messages (
  id         bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  name       text,
  email      text NOT NULL,
  message    text NOT NULL,
  lang       text,
  track      text                    -- deal track captured with a price-gate lead (single value: compra_directa)
);
CREATE INDEX IF NOT EXISTS contact_messages_created_idx ON contact_messages (created_at DESC);
ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS track text;

-- Audit trail: every status change the team makes
CREATE TABLE IF NOT EXISTS status_history (
  id         bigserial PRIMARY KEY,
  folio      text NOT NULL REFERENCES submissions(folio) ON DELETE CASCADE,
  status     text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- VAULT (storage pipeline). Metadata only: file CONTENTS never live in
-- this database. Contents live in: staging bucket (cloud, 7 days) →
-- master bucket (vault rack) → per-engagement viewing copies (vault rack).
-- =====================================================================

-- Every file a seller sends (sample or full corpus)
CREATE TABLE IF NOT EXISTS upload_files (
  id             uuid PRIMARY KEY,
  folio          text NOT NULL REFERENCES submissions(folio) ON DELETE RESTRICT,
  kind           text NOT NULL DEFAULT 'sample' CHECK (kind IN ('sample','corpus')),
  original_name  text NOT NULL,
  ext            text NOT NULL,
  size_bytes     bigint,
  staging_key    text UNIQUE NOT NULL,
  sha256_upload  text,                       -- computed by the web server (small files) or null (direct uploads)
  sha256_staging text,                       -- computed by the ingest worker reading staging
  sha256_master  text,                       -- re-read from master after copy; must equal staging
  scan_status    text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','infected','format_mismatch','skipped','error')),
  scan_detail    text,
  status         text NOT NULL DEFAULT 'awaiting_upload' CHECK (status IN ('awaiting_upload','in_staging','ingested','quarantined','failed')),
  master_key     text,
  quarantine_key text,
  profile        jsonb,                      -- stats only (type, rows, columns, pages): what the team sees to verify
  created_at     timestamptz NOT NULL DEFAULT now(),
  staged_at      timestamptz,
  ingested_at    timestamptz,
  claimed_by     text,                       -- ingest worker currently processing it
  claimed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS upload_files_status_idx ON upload_files (status, staged_at);
CREATE INDEX IF NOT EXISTS upload_files_folio_idx ON upload_files (folio);

-- One corpus per folio. Locked until an admin verifies it.
CREATE TABLE IF NOT EXISTS corpora (
  folio        text PRIMARY KEY REFERENCES submissions(folio) ON DELETE RESTRICT,
  status       text NOT NULL DEFAULT 'locked' CHECK (status IN ('locked','verified','rejected')),
  file_count   integer NOT NULL DEFAULT 0,
  total_bytes  bigint NOT NULL DEFAULT 0,
  verified_at  timestamptz,
  verified_by  text,
  note         text
);

-- One row per ingest run of a file batch
CREATE TABLE IF NOT EXISTS ingest_records (
  id          bigserial PRIMARY KEY,
  folio       text NOT NULL,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  files       jsonb NOT NULL,   -- [{id,name,size,sha256,master_key|quarantine_key,result}]
  result      text NOT NULL
);

-- A buyer/lab engagement = one viewing copy, one watermark identity, one expiry
CREATE TABLE IF NOT EXISTS engagements (
  id              uuid PRIMARY KEY,
  kind            text NOT NULL DEFAULT 'buyer' CHECK (kind IN ('buyer','internal_review')),
  buyer_name      text NOT NULL,
  folios          text[] NOT NULL,
  redaction       jsonb NOT NULL DEFAULT '{"mode":"pii"}',
  expires_at      timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','building','ready','failed','expired','revoked')),
  viewing_prefix  text NOT NULL,
  manifest        jsonb,         -- [{id,name,type,viewing_key,pages}] built by the builder
  withheld        jsonb,         -- files left out of the viewing copy and why
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  built_at        timestamptz,
  closed_at       timestamptz,
  last_error      text
);

CREATE TABLE IF NOT EXISTS viewers (
  id                uuid PRIMARY KEY,
  engagement_id     uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  name              text NOT NULL,
  email             text NOT NULL,
  invite_hash       text UNIQUE NOT NULL,   -- sha256 of the invite link token
  code_hash         text NOT NULL,          -- sha256 of the access code sent separately
  created_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  failed_logins     integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS viewer_sessions (
  id            uuid PRIMARY KEY,
  viewer_id     uuid NOT NULL REFERENCES viewers(id) ON DELETE CASCADE,
  engagement_id uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  token_hash    text UNIQUE NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  end_reason    text,
  ip            text,
  user_agent    text,
  page_views    integer NOT NULL DEFAULT 0,
  warnings      integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS viewer_sessions_open_idx ON viewer_sessions (engagement_id) WHERE ended_at IS NULL;

-- Work queue for the vault workers (claimed with FOR UPDATE SKIP LOCKED)
CREATE TABLE IF NOT EXISTS jobs (
  id         bigserial PRIMARY KEY,
  type       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  status     text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  run_after  timestamptz NOT NULL DEFAULT now(),
  attempts   integer NOT NULL DEFAULT 0,
  locked_by  text,
  locked_at  timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs (status, run_after);

-- Append-only, hash-chained audit log. Each row's hash covers the previous
-- row's hash, so editing or deleting any past row breaks the chain.
CREATE TABLE IF NOT EXISTS audit_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor         text NOT NULL,           -- 'admin', 'seller:<folio>', 'viewer:<id>', 'worker:ingest', ...
  action        text NOT NULL,           -- e.g. ingest.ok, view.page, room.cut, admin.verify
  folio         text,
  engagement_id uuid,
  detail        jsonb NOT NULL DEFAULT '{}',
  prev_hash     text,
  hash          text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_log_folio_idx ON audit_log (folio, id);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action, id);

-- =====================================================================
-- OWNER CRM + STAFF CONSOLE (Nov 24 2026). The team panel is ONE owner
-- CRM: staff accounts, the per-file record (assignment, stuck reason,
-- missing-items checklist, conversation thread), the email outbox and
-- the offer board. Metadata only — file contents never live here.
-- =====================================================================

-- Who is working on a file (staff email; null = unassigned)
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS assigned_to text;

-- Individual staff logins (the shared ADMIN_PASSWORD remains only as a
-- bootstrap / emergency admin). Passwords are scrypt hashes, never plain.
CREATE TABLE IF NOT EXISTS staff_users (
  id            uuid PRIMARY KEY,
  email         text UNIQUE NOT NULL,
  name          text NOT NULL,
  role          text NOT NULL DEFAULT 'ops' CHECK (role IN ('admin','ops')),
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Email outbox: every outbound message is written here FIRST. A row is
-- 'queued' until a real transport (OUTBOX_WEBHOOK_URL) confirms delivery;
-- nothing is ever marked sent without that confirmation.
CREATE TABLE IF NOT EXISTS email_outbox (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL,               -- partner_invite | seller_missing_items | seller_status | manual
  channel       text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','whatsapp')),
  to_email      text,
  to_name       text,
  subject       text,
  body          text NOT NULL,
  folio         text,
  engagement_id uuid,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  transport_note text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);
CREATE INDEX IF NOT EXISTS email_outbox_created_idx ON email_outbox (created_at DESC);

-- Offer board: every partner offer on a corpus, recorded by staff.
-- Accepting/rejecting is a HUMAN decision; the system never accepts.
CREATE TABLE IF NOT EXISTS offers (
  id            bigserial PRIMARY KEY,
  folio         text,
  engagement_id uuid,
  partner_name  text NOT NULL,
  partner_email text,
  amount        numeric NOT NULL,
  currency      text NOT NULL DEFAULT 'USD',
  terms_note    text,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','rejected')),
  recorded_by   text,
  decided_by    text,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS offers_folio_idx ON offers (folio, created_at DESC);
CREATE INDEX IF NOT EXISTS offers_engagement_idx ON offers (engagement_id, created_at DESC);

-- Partner conversation queue: replies/questions tied to an engagement.
CREATE TABLE IF NOT EXISTS partner_messages (
  id            bigserial PRIMARY KEY,
  engagement_id uuid,
  folio         text,
  direction     text NOT NULL CHECK (direction IN ('in','out')),
  channel       text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','whatsapp')),
  author        text,
  text          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_messages_eng_idx ON partner_messages (engagement_id, id);

-- The per-file conversation thread: missing-items requests, seller
-- replies and automatic system entries (uploads received) — the whole
-- back-and-forth lives on the file record, not scattered across inboxes.
CREATE TABLE IF NOT EXISTS file_messages (
  id         bigserial PRIMARY KEY,
  folio      text NOT NULL,
  direction  text NOT NULL CHECK (direction IN ('in','out','system')),
  kind       text NOT NULL DEFAULT 'note',   -- missing_request | reply | checklist_received | note
  author     text,
  text       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS file_messages_folio_idx ON file_messages (folio, id);

-- Missing-items checklist per file: the 5 manifest items plus anything
-- the analysis flags. An item flips to 'received' automatically when a
-- matching file finishes ingest (match hint in `expect`: a substring of
-- the file name, or its extension).
CREATE TABLE IF NOT EXISTS checklist_items (
  id              bigserial PRIMARY KEY,
  folio           text NOT NULL,
  source          text NOT NULL DEFAULT 'staff' CHECK (source IN ('manifest','analysis','staff')),
  label           text NOT NULL,
  expect          text,
  status          text NOT NULL DEFAULT 'missing' CHECK (status IN ('missing','requested','received')),
  satisfied_by_file uuid,
  requested_at    timestamptz,
  received_at     timestamptz,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS checklist_folio_idx ON checklist_items (folio, id);

-- The structured "why is this file stuck / why hasn't it sold" record.
CREATE TABLE IF NOT EXISTS file_notes (
  folio          text PRIMARY KEY,
  reason_category text CHECK (reason_category IN ('waiting_seller_docs','in_analysis','out_with_buyers','offers_too_low','buyer_questions_pending','other')),
  note           text,
  next_action    text,
  action_owner   text,
  updated_by     text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Engagements: the partner contact for outreach, and the staff file
-- selection. selected_files NULL = every ingested file of the folios;
-- an array = ONLY those upload_files ids go into the viewing copy, the
-- rest are recorded as withheld ("not selected by the team").
ALTER TABLE engagements ADD COLUMN IF NOT EXISTS selected_files jsonb;
ALTER TABLE engagements ADD COLUMN IF NOT EXISTS partner_name text;
ALTER TABLE engagements ADD COLUMN IF NOT EXISTS partner_email text;

CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(727274);           -- one writer at a time keeps the chain linear
  SELECT hash INTO NEW.prev_hash FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.at := clock_timestamp();
  NEW.hash := encode(sha256(convert_to(
      coalesce(NEW.prev_hash,'') || '|' || to_char(NEW.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || '|' ||
      NEW.actor || '|' || NEW.action || '|' || coalesce(NEW.folio,'') || '|' ||
      coalesce(NEW.engagement_id::text,'') || '|' || NEW.detail::text, 'UTF8')), 'hex');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION audit_log_readonly() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_chain_t ON audit_log;
CREATE TRIGGER audit_log_chain_t BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_chain();
DROP TRIGGER IF EXISTS audit_log_ro_t ON audit_log;
CREATE TRIGGER audit_log_ro_t BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_readonly();
DROP TRIGGER IF EXISTS audit_log_trunc_t ON audit_log;
CREATE TRIGGER audit_log_trunc_t BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_readonly();
