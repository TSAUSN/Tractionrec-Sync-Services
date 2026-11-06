# Names and settings shared by the deploy scripts (sourced, not run).
# Each value can be overridden from the environment, e.g. PROJECT=other-project.
# Per-center settings are not here: each center is .env.<id> locally and the
# secret center-<id> in Secret Manager (.env.center.example).

PROJECT="${PROJECT:-kroc-services}"
REGION="${REGION:-us-west1}"

FUNCTION="${FUNCTION:-kroc-tractionrec-sync}"
RUNTIME_SA="kroc-sync-runtime@${PROJECT}.iam.gserviceaccount.com"
SCHEDULER_SA="kroc-sync-scheduler@${PROJECT}.iam.gserviceaccount.com"

# One Cloud Scheduler job per center: <JOB_PREFIX><center id>.
JOB_PREFIX="${JOB_PREFIX:-${FUNCTION}-}"

# Every center secret carries this label, which is how the scripts list them.
CENTER_LABEL="kroc-sync=center"

ALERT_EMAIL="${ALERT_EMAIL:-japhethlouie@gmail.com}"

# The deployed centers (their secrets), one id per line.
center_ids() {
  gcloud secrets list --project="$PROJECT" --filter="labels.${CENTER_LABEL%%=*}=${CENTER_LABEL#*=}" \
    --format="value(name.basename())" | sed -n 's/^center-//p' | sort
}

# One setting of a deployed center that is not secret: center_field <id> <KEY>
center_field() {
  case "$2" in CENTER_NAME|SCHEDULE|TIME_ZONE|TR_LOGIN_URL|ZESTY_INSTANCE_ZUID) ;;
    *) echo "center_field: $2 is not a readable setting" >&2; return 1 ;; esac
  gcloud secrets versions access latest --secret="center-$1" --project="$PROJECT" |
    node -e 'let s=""; process.stdin.on("data", (d) => (s += d)).on("end", () => console.log(JSON.parse(s)[process.argv[1]] || ""))' "$2"
}
