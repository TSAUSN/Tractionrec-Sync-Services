#!/usr/bin/env bash
# Puts the sync's secrets into Secret Manager and lets the function's runtime
# service account read them. Values are never printed. Run from anywhere:
#
#   bash deploy/secrets.sh               the trigger key (if missing) + every
#                                        center file on this machine
#   bash deploy/secrets.sh <id> [<id>]   the trigger key (if missing) + these
#   bash deploy/secrets.sh --rotate-key  a new trigger key; then run
#                                        deploy.sh function schedule check,
#                                        or every call gets 403
#
# Secrets:
#   sync-trigger-key  the X-Sync-Key every caller sends. From SYNC_TRIGGER_KEY
#                     in .env if set, else generated (64 hex characters).
#                     Read it back: gcloud secrets versions access latest --secret=sync-trigger-key
#   center-<id>       everything about one center: .env.<id> (gitignored; see
#                     .env.center.example) as JSON, labelled kroc-sync=center.
#                     A new version is added only when the file differs from
#                     the secret; runs use it from the next call on.
set -euo pipefail

# shellcheck source=deploy/config.sh
source "$(dirname "$0")/config.sh"
cd "$(dirname "$0")/.."

ROTATE_KEY=""
IDS=()
for arg in "$@"; do
  case "$arg" in
    --rotate-key) ROTATE_KEY=1 ;;
    -*) echo "usage: secrets.sh [<id> ...] | --rotate-key"; exit 1 ;;
    *) IDS+=("$arg") ;;
  esac
done

# A value from .env, quotes stripped, never echoed.
val() { [ -f .env ] && grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//" || true; }

exists() { gcloud secrets describe "$1" --project="$PROJECT" >/dev/null 2>&1; }

grant() {
  gcloud secrets add-iam-policy-binding "$1" --project="$PROJECT" \
    --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor \
    >/dev/null 2>&1
}

# put <name> [labels]: the value arrives on stdin and goes straight to gcloud.
put() {
  local name="$1" labels="${2:-}"
  if exists "$name"; then
    gcloud secrets versions add "$name" --data-file=- --project="$PROJECT" >/dev/null
    [ -z "$labels" ] || gcloud secrets update "$name" --update-labels="$labels" --project="$PROJECT" >/dev/null
    echo "✔ $name: new version"
  else
    gcloud secrets create "$name" --data-file=- --replication-policy=automatic \
      ${labels:+--labels="$labels"} --project="$PROJECT" >/dev/null
    echo "✔ $name: created"
  fi
  grant "$name"
}

# The trigger key
if exists sync-trigger-key && [ -z "$ROTATE_KEY" ]; then
  echo "• sync-trigger-key: exists (use --rotate-key to replace)"
  grant sync-trigger-key
else
  key="$(val SYNC_TRIGGER_KEY)"
  [ -n "$key" ] || key="$(openssl rand -hex 32)"
  printf %s "$key" | put sync-trigger-key
fi
[ -z "$ROTATE_KEY" ] || exit 0

# The centers: the named ones, else every center file here
if [ ${#IDS[@]} -eq 0 ]; then
  mapfile -t IDS < <(node -e 'for (const c of require("./src/centers").listLocalCenters()) console.log(c.id)')
  [ ${#IDS[@]} -gt 0 ] || echo "• no .env.<id> center files here"
fi
for id in "${IDS[@]}"; do
  name="center-$id"
  # Checked and serialised in memory; never reaches the terminal or a file.
  json="$(node -e '
    const c = require("./src/centers").readLocalCenter(process.argv[1]);
    if (!c) { console.error(`.env.${process.argv[1]} is not a center file here (it needs CENTER_NAME)`); process.exit(1); }
    process.stdout.write(JSON.stringify(c));
  ' "$id")" || exit 1
  if exists "$name"; then
    current="$(gcloud secrets versions access latest --secret="$name" --project="$PROJECT" 2>/dev/null || true)"
    if [ "$(printf %s "$current" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(s)))}catch{console.log("")}})')" = "$json" ]; then
      gcloud secrets update "$name" --update-labels="$CENTER_LABEL" --project="$PROJECT" >/dev/null
      grant "$name"
      echo "• $name: unchanged"
      continue
    fi
  fi
  printf %s "$json" | put "$name" "$CENTER_LABEL"
done
echo "Done. ${RUNTIME_SA} can read them."
