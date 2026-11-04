# Names and settings shared by the deploy scripts (sourced, not run).
# Each value can be overridden from the environment, e.g. PROJECT=other-project.

PROJECT="${PROJECT:-kroc-services}"
REGION="${REGION:-us-west1}"

FUNCTION="${FUNCTION:-kroc-tractionrec-sync}"
RUNTIME_SA="kroc-sync-runtime@${PROJECT}.iam.gserviceaccount.com"
SCHEDULER_SA="kroc-sync-scheduler@${PROJECT}.iam.gserviceaccount.com"

JOB="${JOB:-kroc-tractionrec-sync-daily}"
SCHEDULE="${SCHEDULE:-0 0 * * *}"
TIME_ZONE="${TIME_ZONE:-America/Phoenix}"

ALERT_EMAIL="${ALERT_EMAIL:-japhethlouie@gmail.com}"

# Non-secret function settings. Traction Rec stays on the sandbox for now.
TR_LOGIN_URL="${TR_LOGIN_URL:-https://krocphoenix--phoenixfsb.sandbox.my.salesforce.com}"
TR_API_VERSION="${TR_API_VERSION:-v62.0}"
ZESTY_INSTANCE_ZUID="${ZESTY_INSTANCE_ZUID:-8-80c0bba6b8-lhkcc7}"
