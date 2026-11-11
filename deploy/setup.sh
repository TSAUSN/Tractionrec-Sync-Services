#!/usr/bin/env bash
# Sets up the sync in a Google Cloud project, from nothing or from wherever
# it stands. The same command covers:
#   - the first setup of a project;
#   - a re-setup (every step checks what exists and only fixes what's missing);
#   - a move to another project, account or organization (--from).
#
# Run from a machine where gcloud is signed in as an Owner of the target
# project, with node and `npm ci` done. The target is PROJECT in
# deploy/config.sh (or PROJECT=<id> bash deploy/setup.sh). Run from anywhere:
#
#   bash deploy/setup.sh                       set up / repair PROJECT
#   bash deploy/setup.sh --from=<old-project>  move: copy each center's passwords
#                                              from the old project, and pause
#                                              the old project's jobs before the
#                                              new ones start
#
# Afterwards: commit deploy/ci.env (and config.sh if you changed it) and push
# to main. That first GitHub deploy proves the whole chain.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/config.sh
source "$DIR/config.sh"
cd "$DIR/.."

FROM=""
for arg in "$@"; do
  case "$arg" in
    --from=*) FROM="${arg#--from=}" ;;
    *) echo "usage: setup.sh [--from=<old-project>]"; exit 1 ;;
  esac
done
[ "$FROM" != "$PROJECT" ] || { echo "✘ --from is the target project itself ($PROJECT)"; exit 1; }

deploy() { bash "$DIR/deploy.sh" "$@"; }

# ── Before anything: who, where, and whether this can work
account="$(gcloud config get-value account 2>/dev/null || true)"
[ -n "$account" ] || { echo "✘ gcloud is not signed in: gcloud auth login"; exit 1; }
gcloud projects describe "$PROJECT" >/dev/null 2>&1 ||
  { echo "✘ project $PROJECT not found, or $account can't see it"; exit 1; }
[ -d node_modules ] || { echo "✘ run npm ci first"; exit 1; }
center_ids >/dev/null || { echo "✘ centers.yaml has problems (npm test names them)"; exit 1; }
echo "Setting up $PROJECT ($REGION) as $account${FROM:+, moving from $FROM}"
echo "Centers: $(center_ids | tr '\n' ' ')"
echo "Alert email: $ALERT_EMAIL   Trusted repo: $GITHUB_REPO @ $GITHUB_BRANCH"

# ── 1. Products, accounts, permissions, the GitHub trust, the trigger key
deploy apis
billing="$(gcloud billing projects describe "$PROJECT" --format="value(billingEnabled)" 2>/dev/null || true)"
if [ "$billing" = "False" ]; then
  echo "✘ $PROJECT has no billing account linked (Cloud Console → Billing)."
  echo "  Functions, Scheduler and Secret Manager need billing, even within the free tier."
  exit 1
elif [ "$billing" != "True" ]; then
  echo "⚠ couldn't read $PROJECT's billing status; continuing (a step fails clearly if billing is off)"
fi
deploy accounts access github secrets

# ── 2. Each center's three passwords
for id in $(center_ids); do
  for name in $(center_secret_names "$id"); do
    if gcloud secrets versions list "$name" --project="$PROJECT" --filter="state=ENABLED" \
        --limit=1 --format="value(name)" 2>/dev/null | grep -q .; then
      continue
    fi
    if [ -n "$FROM" ]; then
      # Straight from one project's secret into the other's; never printed.
      value="$(gcloud secrets versions access latest --secret="$name" --project="$FROM")" ||
        { echo "✘ can't read $name in $FROM"; exit 1; }
      if gcloud secrets describe "$name" --project="$PROJECT" >/dev/null 2>&1; then
        printf %s "$value" | gcloud secrets versions add "$name" --data-file=- --project="$PROJECT" >/dev/null
      else
        printf %s "$value" | gcloud secrets create "$name" --data-file=- --replication-policy=automatic \
          --labels="$CENTER_SECRET_LABEL,center=$id" --project="$PROJECT" >/dev/null
      fi
      unset value
      echo "✔ $name: copied from $FROM"
    else
      echo "• $id needs its passwords:"
      bash "$DIR/center-secrets.sh" "$id"
      break
    fi
  done
done

# ── 3. The function, then what needs it to exist
deploy verify function access invoker alerts

# ── 4. Stop the old project's jobs before this project's start
if [ -n "$FROM" ]; then
  for job in $(gcloud scheduler jobs list --location="$REGION" --project="$FROM" \
      --format="value(name.basename())" --filter="name:${JOB_PREFIX}" 2>/dev/null); do
    gcloud scheduler jobs pause "$job" --location="$REGION" --project="$FROM" >/dev/null
    echo "✔ $FROM: $job paused"
  done
fi

# ── 5. The jobs, a dry run of every center, and the values GitHub needs
deploy schedule check ci

cat <<NEXT

Done. $PROJECT is set up and every center dry-ran.
Next:
  1. Commit deploy/ci.env${FROM:+ and deploy/config.sh} and push to main. The GitHub
     deploy that follows signs in to $PROJECT and repeats the checks.
NEXT
if [ -n "$FROM" ]; then
  cat <<OLD
  2. Once that run is green, retire $FROM (its jobs are paused, not deleted):
       gcloud scheduler jobs delete ${JOB_PREFIX}<id> --location=$REGION --project=$FROM
       gcloud functions delete $FUNCTION --region=$REGION --project=$FROM
       gcloud iam workload-identity-pools delete $WIF_POOL --location=global --project=$FROM
       gcloud secrets delete center-<id>-… sync-trigger-key --project=$FROM
     or shut the whole project down in the Cloud Console.
OLD
fi
