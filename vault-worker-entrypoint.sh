#!/bin/sh
# Vault worker entrypoint. With WITH_CLAMD=true (the ingest worker),
# refresh signatures, start the local clamd, and wait until it answers
# on 127.0.0.1:3310 before exec'ing the service command. Without it,
# just exec the command (builder / future workers).
set -e
if [ "$WITH_CLAMD" = "true" ]; then
  mkdir -p /var/run/clamav /var/log/clamav
  chown clamav:clamav /var/run/clamav /var/log/clamav 2>/dev/null || true
  freshclam --quiet || true
  clamd || true
  i=0
  while [ $i -lt 90 ]; do
    if node -e "const n=require('net');const s=n.connect(3310,'127.0.0.1',()=>process.exit(0));s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1500)"; then
      echo "vault-worker entrypoint: clamd is answering on 127.0.0.1:3310"
      break
    fi
    i=$((i + 1))
    sleep 2
  done
  echo "vault-worker entrypoint: clamd wait finished after $i checks (worker retries scans on its own if the daemon is still loading)"
fi
exec "$@"
