-- Separate database logins per service (run as the database owner after the first start).
-- Replace the passwords, then give each service its own DATABASE_URL.
-- Nobody but the owner can UPDATE/DELETE audit_log (and the trigger blocks even the owner).
CREATE ROLE dp_ingest   LOGIN PASSWORD 'change-me';
CREATE ROLE dp_builder  LOGIN PASSWORD 'change-me';
CREATE ROLE dp_dataroom LOGIN PASSWORD 'change-me';

GRANT SELECT, UPDATE ON upload_files TO dp_ingest;
GRANT SELECT, INSERT, UPDATE ON corpora TO dp_ingest;
GRANT INSERT ON ingest_records TO dp_ingest;
GRANT USAGE ON SEQUENCE ingest_records_id_seq TO dp_ingest;
GRANT SELECT (folio, status), UPDATE (status) ON submissions TO dp_ingest;   -- only to move status to 'Muestra recibida'
GRANT SELECT, UPDATE ON jobs TO dp_ingest;

GRANT SELECT ON engagements, corpora, upload_files TO dp_builder;
GRANT UPDATE (status, manifest, withheld, built_at, closed_at, last_error) ON engagements TO dp_builder;
GRANT SELECT (id, engagement_id, ended_at), UPDATE (ended_at, end_reason) ON viewer_sessions TO dp_builder;
GRANT SELECT, UPDATE ON jobs TO dp_builder;

GRANT SELECT (id, engagement_id, name, email, invite_hash, code_hash, revoked_at, failed_logins) ON viewers TO dp_dataroom;
GRANT UPDATE (failed_logins) ON viewers TO dp_dataroom;
GRANT SELECT (id, buyer_name, status, expires_at, manifest) ON engagements TO dp_dataroom;
GRANT SELECT, INSERT, UPDATE ON viewer_sessions TO dp_dataroom;

GRANT SELECT, INSERT ON audit_log TO dp_ingest, dp_builder, dp_dataroom;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO dp_ingest, dp_builder, dp_dataroom;
-- The data room cannot read submissions, contacts, files, hashes or anything about other engagements' sellers.
