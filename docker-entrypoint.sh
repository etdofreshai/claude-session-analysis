#!/bin/sh
set -eu

mkdir -p /data/archive /data/.ssh
chmod 700 /data/.ssh

# Bootstrap a dedicated deploy key into the persistent volume on first deploy.
# The bootstrap env can be removed after the volume has been verified.
if [ -n "${SESSION_SSH_PRIVATE_KEY_B64:-}" ] && [ ! -s /data/.ssh/id_ed25519 ]; then
  printf '%s' "$SESSION_SSH_PRIVATE_KEY_B64" | base64 -d > /data/.ssh/id_ed25519
  chmod 600 /data/.ssh/id_ed25519
fi

# Seed the durable Dokploy archive from the Mini's existing append-only archive
# exactly once. Interrupted copies remain resumable; the marker is written only
# after rsync succeeds. Subsequent app syncs pull new files from each live host.
if [ -n "${ARCHIVE_BOOTSTRAP_SOURCE:-}" ] && [ ! -f /data/.archive-bootstrapped ]; then
  rsync -az --partial --timeout=60 \
    -e 'ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new' \
    "$ARCHIVE_BOOTSTRAP_SOURCE" /data/archive/
  touch /data/.archive-bootstrapped
fi

exec "$@"
