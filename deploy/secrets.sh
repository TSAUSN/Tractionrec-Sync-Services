#!/usr/bin/env bash
# Puts the sync's four secrets into Secret Manager and lets the function's
# runtime service account read them. Values come from .env and are never
# printed. Run from the repo root:
#
#   bash deploy/secrets.sh            create the secrets that don't exist yet
#   bash deploy/secrets.sh --rotate   add a new version to every secret (after
#                                     changing .env), e.g. a new Zesty token
#
# SYNC_TRIGGER_KEY: taken from .env if set there, else generated (random,
# 64 hex characters). Read it back with:
#   gcloud secrets versions access latest --secret=sync-trigger-key
set -euo pipefail

PROJECT="${PROJECT:-kroc-services}"
RUNTIME_SA="kroc-sync-runtime@${PROJECT}.iam.gserviceaccount.com"
ROTATE="${1:-}"
cd "$(dirname "$0")/.."
[ -f .env ] || { echo ".env not found in $(pwd)"; exit 1; }

# A value from .env, quotes stripped, never echoed.
val() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//"; }

put() { # secret-name value
  local name="$1" value="$2"
  [ -n "$value" ] || { echo "✘ $name: no value in .env"; exit 1; }
  if gcloud secrets describe "$name" --project="$PROJECT" >/dev/null 2>&1; then
    if [ "$ROTATE" = "--rotate" ]; then
      printf %s "$value" | gcloud secrets versions add "$name" --data-file=- --project="$PROJECT" >/dev/null
      echo "✔ $name: new version (${#value} chars)"
    else
      echo "• $name: already exists (use --rotate to replace)"
    fi
  else
    printf %s "$value" | gcloud secrets create "$name" --data-file=- --replication-policy=automatic --project="$PROJECT" >/dev/null
    echo "✔ $name: created (${#value} chars)"
  fi
  gcloud secrets add-iam-policy-binding "$name" --project="$PROJECT" \
    --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor >/dev/null
}

TRIGGER="$(val SYNC_TRIGGER_KEY)"
if [ -z "$TRIGGER" ]; then
  if gcloud secrets describe sync-trigger-key --project="$PROJECT" >/dev/null 2>&1 && [ "$ROTATE" != "--rotate" ]; then
    TRIGGER="(kept)"
  else
    TRIGGER="$(openssl rand -hex 32)"
  fi
fi

put tr-client-id "$(val TR_CLIENT_ID)"
put tr-client-secret "$(val TR_CLIENT_SECRET)"
put zesty-instance-token "$(val ZESTY_INSTANCE_TOKEN)"
[ "$TRIGGER" = "(kept)" ] && echo "• sync-trigger-key: already exists" || put sync-trigger-key "$TRIGGER"
echo "Done. ${RUNTIME_SA} can read all four."
