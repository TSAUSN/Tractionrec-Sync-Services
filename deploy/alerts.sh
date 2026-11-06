#!/usr/bin/env bash
# Email alert for the sync. Creates an email notification channel and a
# log-based alert policy (or updates the policy to this definition) that fires,
# for any center, when:
#   - a run finishes with errors       (sync.done with errorCount > 0)
#   - a run fails outright             (sync.failed, HTTP 500)
#   - the function logs any ERROR line (a failed create / update / page write)
#   - a center's Scheduler call fails  (function unreachable, 403, timeout)
# Every log line carries the center id, so the email's log entry names it.
# At most one email per 5 minutes; an incident closes itself after 7 days.
#
#   bash deploy/alerts.sh                       (ALERT_EMAIL from deploy/config.sh)
#   ALERT_EMAIL=someone@example.com bash deploy/alerts.sh
set -euo pipefail

# shellcheck source=deploy/config.sh
source "$(dirname "$0")/config.sh"
EMAIL="$ALERT_EMAIL"
NAME="${FUNCTION}: run errors"

channel="$(gcloud beta monitoring channels list --project="$PROJECT" \
  --filter="type=\"email\" AND labels.email_address=\"$EMAIL\"" --format="value(name)" | head -1)"
if [ -z "$channel" ]; then
  channel="$(gcloud beta monitoring channels create --project="$PROJECT" \
    --display-name="KROC sync alerts ($EMAIL)" --type=email \
    --channel-labels=email_address="$EMAIL" --format="value(name)")"
  echo "✔ email channel created: $channel"
else
  echo "• email channel exists: $channel"
fi

existing="$(gcloud alpha monitoring policies list --project="$PROJECT" \
  --filter="displayName=\"$NAME\"" --format="value(name)" | head -1)"

policy="$(mktemp)"
cat > "$policy" <<JSON
{
  "displayName": "$NAME",
  "combiner": "OR",
  "severity": "ERROR",
  "conditions": [{
    "displayName": "Sync run reported errors, failed, or was not reached",
    "conditionMatchedLog": {
      "filter": "(resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$FUNCTION\" AND ((jsonPayload.message=\"sync.done\" AND jsonPayload.errorCount>0) OR jsonPayload.message=\"sync.failed\" OR severity>=ERROR)) OR (resource.type=\"cloud_scheduler_job\" AND resource.labels.job_id:\"${JOB_PREFIX}\" AND severity>=ERROR)"
    }
  }],
  "alertStrategy": {
    "notificationRateLimit": { "period": "300s" },
    "autoClose": "604800s"
  },
  "notificationChannels": ["$channel"],
  "documentation": {
    "mimeType": "text/markdown",
    "content": "The Traction Rec -> Zesty sync (function $FUNCTION, project $PROJECT) reported a problem.\n\nOpen the matching log entry from this incident. A finished run's report is in the sync.done line (errorCount) and the per-dataset lines before it; sync.failed carries the error message. The center is in the entry (center, or the job name ${JOB_PREFIX}<center>). Rerun one center with: gcloud scheduler jobs run ${JOB_PREFIX}<center> --location=$REGION. Docs: kroc-tractionrec-sync/AGENTS.md §5."
  }
}
JSON
if [ -n "$existing" ]; then
  gcloud alpha monitoring policies update "$existing" --project="$PROJECT" --policy-from-file="$policy" --format=none
  echo "✔ alert policy updated: $NAME -> $EMAIL"
else
  gcloud alpha monitoring policies create --project="$PROJECT" --policy-from-file="$policy" --format=none
  echo "✔ alert policy created: $NAME -> $EMAIL"
fi
rm -f "$policy"
