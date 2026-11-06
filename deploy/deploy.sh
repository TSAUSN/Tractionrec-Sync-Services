#!/usr/bin/env bash
# Deploys the sync and everything around it. Every step checks what already
# exists and creates or updates only what's missing or different, so the whole
# script is safe to rerun. Run from anywhere:
#
#   bash deploy/deploy.sh                    every step, in order
#   bash deploy/deploy.sh function check     only these steps (a code redeploy)
#
# Steps:
#   apis      switch on the Google Cloud products the sync uses
#   accounts  the two service accounts (runtime, scheduler caller)
#   secrets   Secret Manager values from .env (deploy/secrets.sh)
#   function  deploy the code from this folder
#   invoker   let only the scheduler account call the function
#   schedule  one Cloud Scheduler job per center in Secret Manager
#   alerts    the error email (deploy/alerts.sh)
#   check     a dry run over HTTP for every center: plans, writes nothing
#
# Names and settings: deploy/config.sh. Centers: the center-<id> secrets
# (deploy/secrets.sh copies them from .env.<id>), so the schedule and check
# steps work from any machine signed in to the project.
# Secrets are never printed.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/config.sh
source "$DIR/config.sh"
cd "$DIR/.."

ALL=(apis accounts secrets function invoker schedule alerts check)
STEPS=("$@")
[ ${#STEPS[@]} -gt 0 ] || STEPS=("${ALL[@]}")

step_apis() {
  gcloud services enable --project="$PROJECT" \
    cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
    artifactregistry.googleapis.com secretmanager.googleapis.com \
    cloudscheduler.googleapis.com logging.googleapis.com \
    monitoring.googleapis.com iam.googleapis.com
  echo "✔ APIs enabled"
}

ensure_sa() { # email display-name
  local email="$1" name="${1%%@*}"
  if gcloud iam service-accounts describe "$email" --project="$PROJECT" >/dev/null 2>&1; then
    echo "• $email exists"
  else
    gcloud iam service-accounts create "$name" --project="$PROJECT" --display-name="$2" >/dev/null
    echo "✔ $email created"
  fi
}

step_accounts() {
  ensure_sa "$RUNTIME_SA" "KROC sync function runtime"
  ensure_sa "$SCHEDULER_SA" "KROC sync scheduler caller"
}

step_secrets() {
  bash "$DIR/secrets.sh"
}

step_function() {
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "⚠ uncommitted changes: they are deployed too (the upload is this folder as it is now)"
  fi
  # DRY_RUN=0 is required: the code defaults to a dry run. One instance, one
  # request at a time, because the code has no lock (AGENTS.md §5). Center
  # secrets are not bound here: the function reads center-<id> per run.
  gcloud functions deploy "$FUNCTION" \
    --gen2 --runtime=nodejs22 --region="$REGION" --project="$PROJECT" \
    --service-account="$RUNTIME_SA" \
    --source=. --entry-point=sync --trigger-http --no-allow-unauthenticated \
    --timeout=540s --memory=512Mi --max-instances=1 --concurrency=1 \
    --set-env-vars="DRY_RUN=0,GCP_PROJECT=${PROJECT}" \
    --set-secrets=SYNC_TRIGGER_KEY=sync-trigger-key:latest \
    --quiet --format=none
  echo "✔ function deployed: $(function_url)"
}

function_url() {
  gcloud functions describe "$FUNCTION" --region="$REGION" --project="$PROJECT" \
    --format="value(serviceConfig.uri)"
}

step_invoker() {
  gcloud functions add-invoker-policy-binding "$FUNCTION" --region="$REGION" \
    --project="$PROJECT" --member="serviceAccount:${SCHEDULER_SA}" >/dev/null
  echo "✔ $SCHEDULER_SA may call $FUNCTION"
}

trigger_key() {
  gcloud secrets versions access latest --secret=sync-trigger-key --project="$PROJECT"
}

step_schedule() {
  local url key id job cron tz name verb headers_flag
  url="$(function_url)"
  [ -n "$url" ] || { echo "✘ function not deployed yet: run the function step first"; exit 1; }
  key="$(trigger_key)"
  for id in $(center_ids); do
    job="${JOB_PREFIX}${id}"
    cron="$(center_field "$id" SCHEDULE)"
    tz="$(center_field "$id" TIME_ZONE)"
    name="$(center_field "$id" CENTER_NAME)"
    if gcloud scheduler jobs describe "$job" --location="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
      verb=update headers_flag=--update-headers
    else
      verb=create headers_flag=--headers
    fi
    # Runs at most 600 s; a failed call retries 3 times, 5 minutes apart.
    gcloud scheduler jobs "$verb" http "$job" --location="$REGION" --project="$PROJECT" \
      --description="Daily Traction Rec -> Zesty sync: ${name}" \
      --schedule="$cron" --time-zone="$tz" \
      --uri="${url}/?center=${id}" --http-method=POST \
      --oidc-service-account-email="$SCHEDULER_SA" --oidc-token-audience="$url" \
      "$headers_flag=X-Sync-Key=${key}" \
      --attempt-deadline=600s --max-retry-attempts=3 --min-backoff=300s --max-backoff=300s \
      >/dev/null
    echo "✔ $job ${verb}d: '$cron' $tz"
  done
  # Jobs that call this function but match no center are reported, never
  # deleted: pause or delete them by hand.
  local known
  known=" $(center_ids | sed "s|^|${JOB_PREFIX}|" | tr '\n' ' ') "
  for job in $(gcloud scheduler jobs list --location="$REGION" --project="$PROJECT" \
      --format="value(name.basename())" --filter="httpTarget.uri:${url}"); do
    case "$known" in
      *" $job "*) ;;
      *) echo "⚠ $job calls this function but matches no center secret: pause or delete it" ;;
    esac
  done
}

step_alerts() {
  ALERT_EMAIL="$ALERT_EMAIL" bash "$DIR/alerts.sh"
}

step_check() {
  local url token key id out code failed=0
  url="$(function_url)"
  token="$(gcloud auth print-identity-token)"
  key="$(trigger_key)"
  out="$(mktemp)"
  for id in $(center_ids); do
    # Headers go through stdin so neither value shows in the process list.
    code="$(printf 'Authorization: Bearer %s\nX-Sync-Key: %s\n' "$token" "$key" |
      curl -sS -o "$out" -w '%{http_code}' --max-time 600 -X POST -H @- "${url}/?center=${id}&dry=1")"
    if [ "$code" = 200 ]; then
      node -e '
        const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        const ok = r.center === process.argv[2] && r.dryRun === true && r.errorCount === 0;
        console.log(`${ok ? "✔" : "✘"} ${process.argv[2]}: dry run, HTTP 200, errorCount=${r.errorCount}, ${r.durationMs} ms`);
        process.exit(ok ? 0 : 1);
      ' "$out" "$id" || failed=1
    else
      echo "✘ $id: dry run, HTTP $code"
      head -c 2000 "$out"; echo
      failed=1
    fi
  done
  rm -f "$out"
  [ "$failed" = 0 ] || exit 1
}

echo "Project $PROJECT, region $REGION, steps: ${STEPS[*]}"
for s in "${STEPS[@]}"; do
  declare -F "step_$s" >/dev/null || { echo "✘ unknown step '$s' (steps: ${ALL[*]})"; exit 1; }
  echo "── $s"
  "step_$s"
done
echo "Done."
