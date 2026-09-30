# Operations

> Deploying, scheduling and running the sync. For what it does, read
> [sync-flow.md](sync-flow.md).

---

## Secrets

Four values are secret. None of them belong in this repo, in a `.env` that
gets committed, or anywhere a Zesty view could reach.

| Secret | What it opens |
| :--- | :--- |
| `TR_CLIENT_ID` / `TR_CLIENT_SECRET` | the Traction Rec org |
| `ZESTY_INSTANCE_TOKEN` | write access to the Zesty instance |

**The Traction Rec credential is not inert.** It is read-only for the catalog —
all 13 TREX1 objects report createable/updateable/deletable false, confirmed at
runtime — but the integration user can *query 315 objects*, including 5,536
User records with email, phone and federation identifier, and can write to 123
platform objects (files, Chatter, sharing rules). Treat a leak of it as a
personal-data incident, not as "someone can read our class list".

This is also why the Zesty Integration field was ruled out: it puts the bearer
token in a field config that anyone with CMS access can read. See
`KROC-draft/tractionrec-integration-spec.md` §3.3.

```bash
# One secret per value; grant the function's service account accessor on each.
printf %s "$TR_CLIENT_SECRET" | gcloud secrets create tr-client-secret --data-file=-
printf %s "$ZESTY_INSTANCE_TOKEN" | gcloud secrets create zesty-instance-token --data-file=-
```

Prefer a Zesty **instance token** over `ZESTY_USER_EMAIL` / `ZESTY_USER_PASSWORD`.
The password path exists because the SDK offers it, but it ties the cron to a
human account: when that person rotates their password the sync dies silently
at 3am. The service logs a warning when it is used.

---

## Deploy

```bash
gcloud functions deploy kroc-tractionrec-sync \
  --gen2 --runtime=nodejs22 --region=us-west1 \
  --source=. --entry-point=sync --trigger-http --no-allow-unauthenticated \
  --timeout=540s --memory=512Mi \
  --service-account=kroc-tr-sync@PROJECT.iam.gserviceaccount.com \
  --set-env-vars=TR_LOGIN_URL=https://krocphoenix--phoenixfsb.sandbox.my.salesforce.com,TR_API_VERSION=v62.0,ZESTY_INSTANCE_ZUID=8-80c0bba6b8-lhkcc7,DRY_RUN=1 \
  --set-secrets=TR_CLIENT_ID=tr-client-id:latest,TR_CLIENT_SECRET=tr-client-secret:latest,ZESTY_INSTANCE_TOKEN=zesty-instance-token:latest,SYNC_TRIGGER_KEY=sync-trigger-key:latest
```

`--timeout=540s` is the gen-2 HTTP ceiling and a first full run needs most of
it: ~1,000 snapshot writes, each one a create plus a publish. Once the hash
ledger exists, a steady-state run touches only what changed and finishes in
seconds. If the first run does time out, it is safe to re-run — every write is
keyed on the Traction Rec Id, so a partial run resumes rather than duplicates.

**`DRY_RUN=1` is deliberately in the deploy line.** Flip it to `0` only after a
dry run's report reads correctly.

---

## Schedule

The four tiers change on completely different timescales, so give them
different crons rather than one compromise interval.

```bash
# Catalog structure: categories, programs, courses. Changes a few times a year.
gcloud scheduler jobs create http kroc-tr-sync-structure \
  --schedule="0 4 * * *" --time-zone="America/Phoenix" \
  --uri="https://REGION-PROJECT.cloudfunctions.net/kroc-tractionrec-sync?tiers=program_category,program,course" \
  --http-method=POST \
  --oidc-service-account-email=kroc-tr-sync@PROJECT.iam.gserviceaccount.com \
  --headers="X-Sync-Key=…"

# Classes: schedules, capacity, prices.
gcloud scheduler jobs create http kroc-tr-sync-classes \
  --schedule="*/30 * * * *" --time-zone="America/Phoenix" \
  --uri="https://REGION-PROJECT.cloudfunctions.net/kroc-tractionrec-sync?tiers=class" \
  --http-method=POST \
  --oidc-service-account-email=kroc-tr-sync@PROJECT.iam.gserviceaccount.com \
  --headers="X-Sync-Key=…"
```

Before settling on `*/30`, read
[sync-flow.md §6](sync-flow.md#6-the-freshness-tradeoff--read-this-before-scheduling)
— the interval is the maximum age of every number on the site — and get the
org's daily API request budget from the Traction Rec admin. `/limits` is
disabled for this user, so the ceiling is currently unknown.

Two guards sit in front of the endpoint: Cloud Scheduler's OIDC token (IAM) and
`X-Sync-Key` (a shared secret in a header). The second is cheap insurance
against a misconfigured IAM binding turning this into an open write path into
the CMS.

---

## Running it locally

```bash
cp .env.example .env     # fill in from KROC-draft/"tractionrec creds.md"
npm install

npm run sync:dry                 # plan everything, write nothing
node src/cli.js --tiers=program_category --dry
node src/cli.js --tiers=program_category --live   # 9 records: the safest first write

# Verified working end to end on 2026-09-25: 9 items created and published,
# 9 snapshots serving at https://kroc.zesty.dev/tractionrec/program_category/<id>.json,
# and a second run reporting 9 unchanged with zero writes.
npm test                         # the reconcile decision table
```

`.env` is gitignored. Keep it that way — and note that
`KROC-draft/tractionrec creds.md` is untracked but **not** gitignored, one
`git add .` away from being committed.

---

## Reading a run

Every line on stdout is a JSON object, so Cloud Logging turns it into a
queryable field. The run also returns a report:

```json
{
  "dryRun": false,
  "tiers": {
    "class": {
      "trRecords": 96, "created": 4, "refreshed": 12, "unchanged": 80,
      "skipped": 0, "conflicts": [], "orphans": [], "orphansSuppressed": 3,
      "unlinked": 2, "errors": []
    }
  },
  "errorCount": 0
}
```

| Field | Means | Do what |
| :--- | :--- | :--- |
| `created` | new Zesty items published | check one in the Manager — is the URL right? |
| `refreshed` | snapshots rewritten | nothing |
| `unchanged` | no write needed | nothing. This should be most of them |
| `skipped` | a child whose parent item does not exist yet, or a Traction Rec record with no parent at all | re-run after the parent tier succeeds; if it persists, the parent is failing |
| `conflicts` | two items share one `tractionrec_id` | delete the duplicate in the Manager |
| `orphans` | item whose Traction Rec record is gone | a human decides. **Never auto-deleted** |
| `orphansSuppressed` | filtered tier, so "gone" is ambiguous | nothing — usually a season rolling over |
| `unlinked` | hand-authored items with no id | expected, if the catalog has editorial pages |

Alert on `errorCount > 0` and on the absence of a `sync.done` line — a run that
never reports is worse than one that reports failure.

---

## Failure modes

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| `TractionRec auth failed (400 invalid_client)` | rotated or wrong consumer key/secret | re-mint in the connected app, update the secret |
| 401 mid-run | the session died (~2h, no refresh token exists) | handled: the client re-mints once and retries |
| `Zesty model "classes" not found` | reference name changed in the Manager | update `zestyModel` in `src/config.js` |
| `createItem failed (400): path part X is already in use` | two catalog items want the same root path | handled by `uniquePathPart()`; if it still fires, the used-path registry missed a model |
| `createItem failed (400): found required fields missing` | the model marks editorial fields (hero image, subtitle) as required, and the service does not supply those | clear the `required` flag on them in the Manager — see [sync-flow.md §7](sync-flow.md#7-what-has-to-exist-before-the-first-run) |
| `createItem failed (400)` otherwise | usually a missing `tractionrec_id` field on the model | add the field — see [data-mapping.md](data-mapping.md#the-tractionrec_id-field) |
| Snapshot 404s on the live domain but looks fine in the Manager | the filename has no leading slash | `viewPath()` normalises this; a view created before that fix needs renaming via `updateView` + `publishView` |
| Snapshot 404s on the live domain | the view was created but not published | the service always publishes; if this happens the publish call failed — check `errors` |
| A page renders `WebEngine Error: Parsley …` | a Parsley sequence reached a view's source | `parsleySafeJson()` should prevent this. `?_bypassError=true` renders past it and is how you find the source |
| Snapshots publish an old version | `/web/views` lists a view once per status (`dev`, `live`) with different versions; an index that keeps the last row wins the wrong one | handled by `indexViewRows()`, which keeps the highest |
| Every snapshot rewrites on every run | the hash ledger is unreadable | look for `state.unreadable` in the logs. Harmless but wasteful |
| Every child skipped as "parent missing" although the parents exist | the parent tier was not in this run | handled: `parentIndexFor()` loads the parent model from the instance. A dry run also stands in a placeholder ZUID so the lower tiers still plan |
| Hundreds of orphans after a season change | a filtered tier reported them | should be suppressed; if not, check `orphansAreMeaningful()` |

---

## Things this service deliberately does not do

- **Delete anything.** Not items, not snapshots, not orphans.
- **Update an existing item's fields.** Creating seeds it once; after that the
  item belongs to the editors.
- **Write to Traction Rec.** The credential is read-only for the catalog and
  should stay that way — if a write is ever needed, that is a new conversation
  with the Traction Rec admin, not a new function in this repo.
- **Serve the site.** Nothing renders here. The front end reads the published
  JSON views directly.
