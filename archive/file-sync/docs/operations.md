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
token in a field config that anyone with CMS access can read.

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

`--timeout=540s` is the gen-2 HTTP ceiling. A first full run into an empty
folder writes 364 files (212 records, 4 tier files, 147 children files and the
ledger), each a create plus a publish: **measured 230 s**. Once the hash
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
  --uri="https://REGION-PROJECT.cloudfunctions.net/kroc-tractionrec-sync?tiers=program_categories,programs,courses" \
  --http-method=POST \
  --oidc-service-account-email=kroc-tr-sync@PROJECT.iam.gserviceaccount.com \
  --headers="X-Sync-Key=…"

# Classes: schedules, capacity, prices.
gcloud scheduler jobs create http kroc-tr-sync-classes \
  --schedule="*/30 * * * *" --time-zone="America/Phoenix" \
  --uri="https://REGION-PROJECT.cloudfunctions.net/kroc-tractionrec-sync?tiers=classes" \
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
cp .env.example .env     # fill in the credentials
npm install

npm run sync:dry                 # plan everything, write nothing
node src/cli.js --tiers=program_categories --dry
node src/cli.js --tiers=program_categories --live   # 9 records: the safest first write

# Verified working end to end: 9 items created and published,
# 9 snapshots serving at https://kroc.zesty.dev/tractionrec/program_categories/<id>.json,
# and a second run reporting 9 unchanged with zero writes.
npm test                         # the reconcile decision table
```

`.env` is gitignored. Keep it that way.

---

## Resetting

`src/reset.js` removes everything this service has written, so a sync can be
re-run from clean. It is the tool for correcting a bad snapshot format.

```bash
npm run reset                          # plan only — deletes nothing
npm run reset:live                     # delete every view under /tractionrec/
node src/reset.js --live --tiers=classes # one tier's snapshots
node src/reset.js --live --items       # ...AND the content items (see below)
```

**Views are safe to delete.** Nothing but this service writes under
`/tractionrec/`, and a sync rebuilds them. The SDK has no `deleteView`, but the
API supports `DELETE /web/views/{zuid}` — verified.

⚠️ **Items are not.** An item carrying a `tractionrec_id` may since have gained
a hero image, body copy or SEO text from an editor, and it owns a URL that may
be linked or indexed. Deleting it destroys all of that. `--items` therefore has
to be asked for explicitly, and even then an item with **no** `tractionrec_id`
is never touched — those are hand-authored pages this service did not create.

After a reset the hash ledger is gone too, so the next run rewrites every
snapshot. That is the point; it just means the run takes full-sync time
(~2 minutes for 212 records) rather than seconds.

## Live Parsley runner (`npm run runner`)

A development tool for `/test-page/`: every Parsley code block on that page is
editable, and **Run** executes the edited code on Zesty's servers.

```bash
npm run runner        # http://127.0.0.1:8787 — leave it running while you use the page
```

**Why it needs a local process.** Parsley only runs on Zesty's servers, while
a view renders, so a browser cannot execute it. Running code means writing it
into a view, which needs the Zesty write token, and that token must never be in
a public page. So the page posts the code to this process, which:

1. writes it as a **draft** of the scratch view `/_runner/run.html` (never
   published, so nothing reaches the live site);
2. fetches `<stage>/test-page/?kroc_run=1` (the stage preview domain renders
   drafts, so no publish is needed);
3. returns what sits between this run's markers, or "Parsley error" on Zesty's
   HTTP 500 build-error page.

The test page's view opens with a run-mode branch: with `kroc_run=1` it renders
only the scratch view's draft, otherwise the normal page. Running *inside* the
page, rather than fetching the scratch view directly, gives the code a real
`this` (the test page's item), so code reading `this.integration_test`
runs as written. Parsley does not evaluate an include inside a false `if`, so a
crashing draft cannot break the normal page. Verified; live, the
same URL shows only the scratch view's published placeholder comment.

**Safety.** It binds to `127.0.0.1` only. It refuses any `Origin` except the
instance's domain and its two stage domains, so another website you visit
cannot drive it. It requires a JSON body, which forces a CORS preflight. It
never publishes. The only trace a run leaves is one dev version on the scratch
view.

**Browser notes.** Chrome (142+) asks once to let the page reach your local
network: allow it, or Run reports "runner offline". Safari blocks pages from
calling `http://127.0.0.1`, so use Chrome or Firefox. If the browser runs on a
different machine from this process (e.g. VS Code Remote), forward port 8787;
VS Code does this automatically for a port started in its terminal.

**Limits.** Zesty's build-error page has no line number or message, so a
crash is reported as a crash and nothing more. Scripts in the output do not run
(the output frame is sandboxed). `this` is the test page item, which has no
`tractionrec_id`, so detail-page examples use a literal id.

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
