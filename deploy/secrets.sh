#!/usr/bin/env bash
# The shared trigger key: the X-Sync-Key every Scheduler call sends. Never
# printed. Run from anywhere:
#
#   bash deploy/secrets.sh               create it if it's missing
#   bash deploy/secrets.sh --rotate-key  a new key; then run
#                                        deploy.sh function schedule check,
#                                        or every call gets 403
#
# The value is SYNC_TRIGGER_KEY from .env if set there, else generated (64 hex
# characters). Read it back: gcloud secrets versions access latest --secret=sync-trigger-key
# Each center's own passwords are set with deploy/center-secrets.sh <id>.
set -euo pipefail

# shellcheck source=deploy/config.sh
source "$(dirname "$0")/config.sh"
cd "$(dirname "$0")/.."

case "${1:-}" in ""|--rotate-key) ;; *) echo "usage: secrets.sh [--rotate-key]"; exit 1 ;; esac

val() { [ -f .env ] && grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//" || true; }

if gcloud secrets describe sync-trigger-key --project="$PROJECT" >/dev/null 2>&1; then
  if [ "${1:-}" != "--rotate-key" ]; then
    echo "• sync-trigger-key: exists (use --rotate-key to replace)"
    exit 0
  fi
  verb=(versions add sync-trigger-key) what="new version"
else
  verb=(create sync-trigger-key --replication-policy=automatic) what="created"
fi
key="$(val SYNC_TRIGGER_KEY)"
[ -n "$key" ] || key="$(openssl rand -hex 32)"
printf %s "$key" | gcloud secrets "${verb[@]}" --data-file=- --project="$PROJECT" >/dev/null
echo "✔ sync-trigger-key: $what"
