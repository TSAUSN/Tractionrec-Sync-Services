#!/usr/bin/env bash
# Email alert for the sync. Creates (once) an email notification channel and a
# log-based alert policy that fires when:
#   - a run finishes with errors       (sync.done with errorCount > 0)
#   - a run fails outright             (sync.failed, HTTP 500)
#   - the function logs any ERROR line (a failed create / update / page write)
#   - the Cloud Scheduler call fails   (function unreachable, 403, timeout)
# At most one email per 5 minutes; an incident closes itself after 7 days.
#
#   ALERT_EMAIL=someone@example.com bash deploy/alerts.sh
set -euo pipefail

PROJECT="${PROJECT:-kroc-services}"
EMAIL="${ALERT_EMAIL:?set ALERT_EMAIL}"
NAME="kroc-tractionrec-sync: run errors"

channel="$(gcloud beta monitoring channels list --project="$PROJECT" \
  --filter="type=email AND labels.email_address=$EMAIL" --format="value(name)" | head -1)"
if [ -z "$channel" ]; then
  channel="$(gcloud beta monitoring channels create --project="$PROJECT" \
    --display-name="KROC sync alerts ($EMAIL)" --type=email \
    --channel-labels=email_address="$EMAIL" --format="value(name)")"
  echo "✔ email channel created: $channel"
else
  echo "• email channel exists: $channel"
fi

if gcloud alpha monitoring policies list --project="$PROJECT" --filter="displayName=\"$NAME\"" --format="value(name)" | grep -q .; then
  echo "• alert policy exists: $NAME"
  exit 0
fi

policy="$(mktemp)"
cat > "$policy" <<JSON
{
  "displayName": "$NAME",
  "combiner": "OR",
  "severity": "ERROR",
  "conditions": [{
    "displayName": "Sync run reported errors, failed, or was not reached",
    "conditionMatchedLog": {
      "filter": "(resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"kroc-tractionrec-sync\" AND ((jsonPayload.message=\"sync.done\" AND jsonPayload.errorCount>0) OR jsonPayload.message=\"sync.failed\" OR severity>=ERROR)) OR (resource.type=\"cloud_scheduler_job\" AND resource.labels.job_id=\"kroc-tractionrec-sync-daily\" AND severity>=ERROR)"
    }
  }],
  "alertStrategy": {
    "notificationRateLimit": { "period": "300s" },
    "autoClose": "604800s"
  },
  "notificationChannels": ["$channel"],
  "documentation": {
    "mimeType": "text/markdown",
    "content": "The Traction Rec -> Zesty sync (function kroc-tractionrec-sync, project $PROJECT) reported a problem.\n\nOpen the matching log entry from this incident. A finished run's report is in the sync.done line (errorCount) and the per-dataset lines before it; sync.failed carries the error message. Rerun with: gcloud scheduler jobs run kroc-tractionrec-sync-daily --location=us-west1. Docs: kroc-tractionrec-sync/AGENTS.md §5."
  }
}
JSON
gcloud alpha monitoring policies create --project="$PROJECT" --policy-from-file="$policy" --format="value(name)"
rm -f "$policy"
echo "✔ alert policy created: $NAME -> $EMAIL"
