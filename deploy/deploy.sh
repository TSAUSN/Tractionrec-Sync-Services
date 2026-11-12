#!/usr/bin/env bash
# Deploys the sync and everything around it. Every step checks what already
# exists and creates or updates only what's missing or different, so the whole
# script is safe to rerun. Run from anywhere:
#
#   bash deploy/deploy.sh                    every step, in order (a person, as Owner)
#   bash deploy/deploy.sh function check     only these steps
#
# Merging into main runs `verify function schedule check` from GitHub Actions
# (.github/workflows/deploy.yml); the other steps are one-time setup.
#
# Steps:
#   apis      switch on the Google Cloud products the sync uses
#   accounts  the service accounts: runtime, scheduler caller, deployer (CI)
#   secrets   the shared trigger key (deploy/secrets.sh)
#   access    who may read which secret, and what the deployer may change
#   github    let GitHub Actions on main deploy as the deployer, with no key
#   verify    every center in centers.yaml has its three secrets
#   function  deploy the code (with centers.yaml) from this folder
#   invoker   who may call the function: the scheduler and the deployer
#   schedule  one Scheduler job per center in centers.yaml; delete the rest
#   alerts    the error email (deploy/alerts.sh)
#   check     a dry run over HTTP for every center: plans, writes nothing
#   ci        write deploy/ci.env: the project values GitHub Actions needs
#
# Setting up a project (first time, again, or moving to another project or
# organization) is deploy/setup.sh, which runs these in the right order.
#
# Names and settings: deploy/config.sh. Secrets are never printed.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/config.sh
source "$DIR/config.sh"
cd "$DIR/.."

ALL=(apis accounts secrets access github verify function invoker schedule alerts check ci)
STEPS=("$@")
[ ${#STEPS[@]} -gt 0 ] || STEPS=("${ALL[@]}")

step_apis() {
  # compute: creates the default compute account, which builds run as.
  gcloud services enable --project="$PROJECT" \
    cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
    artifactregistry.googleapis.com secretmanager.googleapis.com \
    cloudscheduler.googleapis.com logging.googleapis.com \
    monitoring.googleapis.com iam.googleapis.com \
    iamcredentials.googleapis.com sts.googleapis.com cloudresourcemanager.googleapis.com \
    cloudbilling.googleapis.com compute.googleapis.com
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
  ensure_sa "$DEPLOYER_SA" "KROC sync deployer (GitHub Actions)"
}

project_role() { # member role [condition]
  gcloud projects add-iam-policy-binding "$PROJECT" --member="$1" --role="$2" \
    --condition="${3:-None}" >/dev/null
}

act_as() { # service account the deployer may run things as
  gcloud iam service-accounts add-iam-policy-binding "$1" --project="$PROJECT" \
    --member="serviceAccount:${DEPLOYER_SA}" --role=roles/iam.serviceAccountUser >/dev/null
}

# Read access to the trigger key; it must exist first (the secrets step).
trigger_grant() {
  gcloud secrets describe sync-trigger-key --project="$PROJECT" >/dev/null 2>&1 ||
    { echo "✘ sync-trigger-key doesn't exist yet: run the secrets step before access"; exit 1; }
  gcloud secrets add-iam-policy-binding sync-trigger-key --project="$PROJECT" \
    --member="serviceAccount:$1" --role=roles/secretmanager.secretAccessor >/dev/null
}

step_access() {
  local num
  num="$(project_number)"
  # The function reads any center-* secret, so a new center needs no grant.
  project_role "serviceAccount:${RUNTIME_SA}" roles/secretmanager.secretAccessor \
    "expression=resource.name.startsWith(\"projects/${num}/secrets/center-\"),title=center secrets,description=The sync reads each center's secrets"
  trigger_grant "$RUNTIME_SA"
  echo "✔ $RUNTIME_SA reads center-* secrets and the trigger key"

  # The deployer: deploy the function, keep the jobs, see (not read) center
  # secrets, read the trigger key (the jobs send it), act as the accounts the
  # function, its build and the jobs run as.
  project_role "serviceAccount:${DEPLOYER_SA}" roles/cloudfunctions.developer
  project_role "serviceAccount:${DEPLOYER_SA}" roles/cloudscheduler.admin
  project_role "serviceAccount:${DEPLOYER_SA}" roles/secretmanager.viewer
  trigger_grant "$DEPLOYER_SA"
  act_as "$RUNTIME_SA"
  act_as "$SCHEDULER_SA"
  act_as "${num}-compute@developer.gserviceaccount.com"
  # Builds run as the default compute account, which newer projects no longer
  # give build rights by default.
  project_role "serviceAccount:${num}-compute@developer.gserviceaccount.com" roles/cloudbuild.builds.builder
  # A deploy re-applies "no public access" to the function's Cloud Run service
  # (run.services.setIamPolicy): Cloud Run Admin on that one service only.
  if gcloud run services describe "$FUNCTION" --region="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
    gcloud run services add-iam-policy-binding "$FUNCTION" --region="$REGION" --project="$PROJECT" \
      --member="serviceAccount:${DEPLOYER_SA}" --role=roles/run.admin >/dev/null
  else
    echo "⚠ $FUNCTION not deployed yet: rerun this step after the first deploy"
  fi
  echo "✔ $DEPLOYER_SA: deploy function, Scheduler jobs, secret names, trigger key"
}

step_github() {
  local num pool provider
  num="$(project_number)"
  pool="projects/${num}/locations/global/workloadIdentityPools/${WIF_POOL}"
  if gcloud iam workload-identity-pools describe "$WIF_POOL" --location=global --project="$PROJECT" >/dev/null 2>&1; then
    echo "• identity pool $WIF_POOL exists"
  else
    gcloud iam workload-identity-pools create "$WIF_POOL" --location=global --project="$PROJECT" \
      --display-name="GitHub Actions" >/dev/null
    echo "✔ identity pool $WIF_POOL created"
  fi
  # Only tokens GitHub issues to this repository's main branch are accepted.
  local args=(--location=global --project="$PROJECT" --workload-identity-pool="$WIF_POOL"
    --issuer-uri="https://token.actions.githubusercontent.com"
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref"
    --attribute-condition="assertion.repository=='${GITHUB_REPO}' && assertion.ref=='refs/heads/${GITHUB_BRANCH}'")
  if gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER" --location=global \
      --workload-identity-pool="$WIF_POOL" --project="$PROJECT" >/dev/null 2>&1; then
    gcloud iam workload-identity-pools providers update-oidc "$WIF_PROVIDER" "${args[@]}" >/dev/null 2>&1
    echo "✔ provider $WIF_PROVIDER updated: $GITHUB_REPO @ $GITHUB_BRANCH"
  else
    gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER" "${args[@]}" >/dev/null
    echo "✔ provider $WIF_PROVIDER created: $GITHUB_REPO @ $GITHUB_BRANCH"
  fi
  gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_SA" --project="$PROJECT" \
    --role=roles/iam.workloadIdentityUser \
    --member="principalSet://iam.googleapis.com/${pool}/attribute.repository/${GITHUB_REPO}" >/dev/null
  provider="${pool}/providers/${WIF_PROVIDER}"
  echo "✔ $GITHUB_REPO may deploy as $DEPLOYER_SA"
  echo "  workflow settings: workload_identity_provider=${provider}"
  echo "                     service_account=${DEPLOYER_SA}"
}

step_secrets() {
  bash "$DIR/secrets.sh"
}

step_verify() {
  local id name missing=0
  # In CI, deploy/ci.env must describe the project config.sh names.
  if [ -n "${GCP_DEPLOYER_SA:-}" ] && [ "$GCP_DEPLOYER_SA" != "$DEPLOYER_SA" ]; then
    echo "✘ deploy/ci.env is for $GCP_DEPLOYER_SA, but config.sh names $PROJECT: run deploy/setup.sh"
    exit 1
  fi
  for id in $(center_ids); do
    for name in $(center_secret_names "$id"); do
      if gcloud secrets versions list "$name" --project="$PROJECT" --filter="state=ENABLED" \
          --limit=1 --format="value(name)" 2>/dev/null | grep -q .; then
        :
      else
        echo "✘ $id: secret $name is missing or has no enabled version"
        missing=1
      fi
    done
    [ "$missing" = 1 ] || echo "✔ $id: its 3 secrets exist"
  done
  [ "$missing" = 0 ] || { echo "  Create them with: bash deploy/center-secrets.sh <id>"; exit 1; }
}

step_function() {
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "⚠ uncommitted changes: they are deployed too (the upload is this folder as it is now)"
  fi
  # DRY_RUN=0 is required: the code defaults to a dry run. One instance, one
  # request at a time, because the code has no lock (AGENTS.md §5). Center
  # secrets are not bound here: the function reads them per run, by name.
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
  local sa
  for sa in "$SCHEDULER_SA" "$DEPLOYER_SA"; do
    gcloud functions add-invoker-policy-binding "$FUNCTION" --region="$REGION" \
      --project="$PROJECT" --member="serviceAccount:${sa}" >/dev/null
    echo "✔ $sa may call $FUNCTION"
  done
}

trigger_key() {
  gcloud secrets versions access latest --secret=sync-trigger-key --project="$PROJECT"
}

step_schedule() {
  local url key id job cron tz name verb headers_flag ids
  url="$(function_url)"
  [ -n "$url" ] || { echo "✘ function not deployed yet: run the function step first"; exit 1; }
  key="$(trigger_key)"
  ids="$(center_ids)"
  for id in $ids; do
    job="${JOB_PREFIX}${id}"
    cron="$(center_field "$id" schedule.cron)"
    tz="$(center_field "$id" schedule.timeZone)"
    name="$(center_field "$id" name)"
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
  # A job that calls this function but whose center left centers.yaml is
  # deleted: centers.yaml is the list, and its changes are reviewed.
  local known
  known=" $(printf '%s\n' $ids | sed "s|^|${JOB_PREFIX}|" | tr '\n' ' ') "
  for job in $(gcloud scheduler jobs list --location="$REGION" --project="$PROJECT" \
      --format="value(name.basename())" --filter="httpTarget.uri:${url}"); do
    case "$known" in
      *" $job "*) ;;
      *)
        gcloud scheduler jobs delete "$job" --location="$REGION" --project="$PROJECT" --quiet >/dev/null
        echo "✔ $job deleted: its center is not in centers.yaml"
        ;;
    esac
  done
}

step_alerts() {
  ALERT_EMAIL="$ALERT_EMAIL" bash "$DIR/alerts.sh"
}

step_check() {
  local url token key id out code failed=0 account
  url="$(function_url)"
  account="$(gcloud config get-value account 2>/dev/null || true)"
  # CI passes a token issued at sign-in (SYNC_ID_TOKEN); a service account key
  # needs the audience named; a person's token can't take one.
  if [ -n "${SYNC_ID_TOKEN:-}" ]; then
    token="$SYNC_ID_TOKEN"
  elif [[ "$account" == *.gserviceaccount.com ]]; then
    token="$(gcloud auth print-identity-token --audiences="$url")"
  else
    token="$(gcloud auth print-identity-token)"
  fi
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

step_ci() {
  local url
  url="$(function_url)"
  [ -n "$url" ] || { echo "✘ function not deployed yet: run the function step first"; exit 1; }
  cat > deploy/ci.env <<CI
# Written by: bash deploy/deploy.sh ci (deploy/setup.sh runs it). The
# project-specific values .github/workflows/deploy.yml needs. Not secret.
GCP_PROJECT_ID=${PROJECT}
GCP_WIF_PROVIDER=projects/$(project_number)/locations/global/workloadIdentityPools/${WIF_POOL}/providers/${WIF_PROVIDER}
GCP_DEPLOYER_SA=${DEPLOYER_SA}
GCP_FUNCTION_URL=${url}
CI
  echo "✔ deploy/ci.env written for $PROJECT (commit it)"
}

echo "Project $PROJECT, region $REGION, steps: ${STEPS[*]}"
for s in "${STEPS[@]}"; do
  declare -F "step_$s" >/dev/null || { echo "✘ unknown step '$s' (steps: ${ALL[*]})"; exit 1; }
  echo "── $s"
  "step_$s"
done
echo "Done."
