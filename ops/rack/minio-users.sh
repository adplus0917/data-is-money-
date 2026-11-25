#!/usr/bin/env bash
# Run once on the rack after MinIO is up. Needs the MinIO client "mc" and the root keys.
# Creates one MinIO user per service, each with its own policy and its own random secret.
set -euo pipefail
# Two servers: master (dp-master + dp-quarantine) and viewing (dp-viewing). Each service gets a user
# ONLY on the server(s) it needs: ingest → master · builder → master (read) + viewing · dataroom → viewing.
mc alias set master "${MASTER_URL:-http://127.0.0.1:9000}" "$MASTER_ROOT_USER" "$MASTER_ROOT_PASSWORD"
mc alias set viewing "${VIEWING_URL:-http://127.0.0.1:9002}" "$VIEWING_ROOT_USER" "$VIEWING_ROOT_PASSWORD"
add() {  # add <server> <service>
  local secret; secret=$(openssl rand -hex 24)
  mc admin user add "$1" "svc-$2" "$secret"
  mc admin policy create "$1" "dp-$2" "$(dirname "$0")/../minio-policies/$2.json"
  mc admin policy attach "$1" "dp-$2" --user "svc-$2"
  echo "[$1] svc-$2  secret: $secret    ← put in ops/env/$2.env, then clear your terminal"
}
add master ingest
add master builder
add viewing builder
add viewing dataroom
