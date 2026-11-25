#!/usr/bin/env bash
# Encrypted off-site copy of the MASTER bucket (cloud = backup only, never the system of record).
# rclone "crypt" encrypts file contents AND names on the rack before upload; the cloud provider
# only ever stores ciphertext. The crypt passwords live in the key server / password manager,
# NOT on the rack's disks: they are passed in through the environment at run time.
# Schedule nightly (systemd timer or cron). Requires: rclone.
#   RCLONE_CONFIG_MINIO_*  : MinIO read-only backup user (GetObject + ListBucket on dp-master)
#   RCLONE_CONFIG_B2_*     : Backblaze B2 application key limited to the backup bucket
#   RCLONE_CONFIG_SAFE_PASSWORD / _PASSWORD2 : crypt passwords (obscured), fetched from the key server
set -euo pipefail
export RCLONE_CONFIG_MINIO_TYPE=s3 RCLONE_CONFIG_MINIO_PROVIDER=Minio RCLONE_CONFIG_MINIO_ENDPOINT=${MINIO_URL:-http://127.0.0.1:9000}
export RCLONE_CONFIG_B2_TYPE=b2
export RCLONE_CONFIG_SAFE_TYPE=crypt RCLONE_CONFIG_SAFE_REMOTE="b2:${B2_BACKUP_BUCKET}/master"
: "${RCLONE_CONFIG_SAFE_PASSWORD:?crypt password must come from the key server}"
# copy (never sync-delete): a file removed from master by mistake still exists in the backup
rclone copy minio:dp-master safe: --checksum --transfers 8 --log-level INFO
rclone check minio:dp-master safe: --one-way --download=false || echo "backup check reported differences" >&2
