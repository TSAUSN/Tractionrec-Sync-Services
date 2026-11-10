#!/usr/bin/env bash
# Creates or replaces one center's three passwords in Secret Manager. Each is
# asked for in turn, hidden as you type; press Enter to keep the current one.
# Nothing is written to a file or shown. Run from anywhere:
#
#   bash deploy/center-secrets.sh <id>
#
# The secrets (also creatable in the Cloud Console, Security -> Secret Manager):
#   center-<id>-tr-client-id       Traction Rec connected app: client id
#   center-<id>-tr-client-secret   Traction Rec connected app: client secret
#   center-<id>-zesty-token        Zesty instance access token
# A new value is used from the center's next run; nothing to redeploy. The
# function's runtime account can read every center-* secret (deploy.sh, step
# access), so a new center needs no extra grant.
set -euo pipefail

# shellcheck source=deploy/config.sh
source "$(dirname "$0")/config.sh"
ID="${1:-}"
[[ "$ID" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || { echo "usage: center-secrets.sh <id>   (lowercase letters, digits, hyphens)"; exit 1; }

for pair in "tr-client-id:Traction Rec client id" "tr-client-secret:Traction Rec client secret" "zesty-token:Zesty instance token"; do
  name="center-${ID}-${pair%%:*}"
  label="${pair#*:}"
  if gcloud secrets describe "$name" --project="$PROJECT" >/dev/null 2>&1; then
    have=1 hint="Enter keeps the current one"
  else
    have="" hint="required"
  fi
  read -r -s -p "$label for $ID ($hint): " value; echo
  if [ -z "$value" ]; then
    [ -n "$have" ] || { echo "✘ $name: a value is required"; exit 1; }
    echo "• $name: kept"
    continue
  fi
  if [ -n "$have" ]; then
    printf %s "$value" | gcloud secrets versions add "$name" --data-file=- --project="$PROJECT" >/dev/null
    echo "✔ $name: new version"
  else
    printf %s "$value" | gcloud secrets create "$name" --data-file=- --replication-policy=automatic \
      --labels="$CENTER_SECRET_LABEL,center=$ID" --project="$PROJECT" >/dev/null
    echo "✔ $name: created"
  fi
  unset value
done
