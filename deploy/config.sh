# Names and settings shared by the deploy scripts (sourced, not run).
# Each value can be overridden from the environment, e.g. PROJECT=other-project.
# The centers are not here: they are centers.yaml (settings) and three Secret
# Manager secrets per center (passwords).

PROJECT="${PROJECT:-kroc-services}"
REGION="${REGION:-us-west1}"

FUNCTION="${FUNCTION:-kroc-tractionrec-sync}"
RUNTIME_SA="kroc-sync-runtime@${PROJECT}.iam.gserviceaccount.com"
SCHEDULER_SA="kroc-sync-scheduler@${PROJECT}.iam.gserviceaccount.com"
# The account GitHub Actions deploys as (Workload Identity Federation).
DEPLOYER_SA="kroc-sync-deployer@${PROJECT}.iam.gserviceaccount.com"

# The repository and branch allowed to deploy, and the trust that lets it.
GITHUB_REPO="${GITHUB_REPO:-TSAUSN/Tractionrec-Sync-Services}"
GITHUB_BRANCH="${GITHUB_BRANCH:-main}"
WIF_POOL="github"
WIF_PROVIDER="github"

# One Cloud Scheduler job per center: <JOB_PREFIX><center id>.
JOB_PREFIX="${JOB_PREFIX:-${FUNCTION}-}"

# Label on every center secret (center-<id>-…), for finding them in the Console.
CENTER_SECRET_LABEL="kroc-sync=center-secret"

ALERT_EMAIL="${ALERT_EMAIL:-japhethlouie@gmail.com}"

# The centers in centers.yaml, one id per line (the repo root is the working dir).
center_ids() {
  node -e 'for (const c of require("./src/centers").listCenters()) console.log(c.id)'
}

# One setting of a center from centers.yaml: center_field <id> <dotted.path>
center_field() {
  node -e '
    const c = require("./src/centers").getCenter(process.argv[1]);
    console.log(process.argv[2].split(".").reduce((o, k) => o[k], c));
  ' "$1" "$2"
}

# The three secret names of a center, one per line.
center_secret_names() {
  node -e 'for (const n of require("./src/centers").secretNames(process.argv[1])) console.log(n)' "$1"
}

project_number() {
  gcloud projects describe "$PROJECT" --format="value(projectNumber)"
}
