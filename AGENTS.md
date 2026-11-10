# AGENTS.md — kroc-tractionrec-sync

Read this before changing anything here. It records how the service works
**now** and the decisions behind it. `docs/` has the design, the
measurements and the reviewer report; this file is the current state.

**What this is:** an HTTP Google Cloud Function (Node 22) serving **several
Kroc centers**, each with its own Traction Rec org and its own Zesty instance
(settings in `centers.yaml`, passwords in Secret Manager; rule 8). Each call
syncs **one center**: it copies that
center's published Traction Rec catalog and memberships into its Zesty
instance. Today that is Phoenix (`8-80c0bba6b8-lhkcc7`, served at
`kroc.zesty.dev`, stage `6wz46m14-dev.webengine.zesty.io`), plus `phoenix-2`, a
test copy pointing at the same org and instance:

- **Nine `tr_*` Zesty datasets:** one item per Traction Rec record, with
  relations between them.
- **The catalog's page items:** one Zesty page per category, program, course
  and class.

Traction Rec is a Salesforce managed package (`TREX1__…`) and the system of
record; the sync is one-way and read-only towards it. **It has no schedule of
its own: a separate service calls it**, one Cloud Scheduler job per center.
**Merging into `main` deploys** (GitHub Actions, §5). The site (`../Kroc-Center-Template`)
reads the datasets in Parsley.

The first version, which wrote JSON files under `/tractionrec/`, is archived
in `archive/file-sync/`. Nothing in `src/` or `test/` uses it.

---

## 1. Layout

```
src/index.js            HTTP entry (functions-framework target "sync"); ?center= (required) &datasets= &dry=1
src/cli.js              local runner: npm run sync[:dry] [-- --center=… --live --datasets=… --summary]
src/centers.js          centers.yaml (checked) + a center's 3 secrets -> a run config
src/config.js           Traction Rec tiers: object, fields, publishing gate, parent, price join;
                        load() = the single-center config from the environment (.env)
src/datasets/
  definitions.js        dataset -> Traction Rec source, field getters, relations, lifecycle, page
  schema.js             definitions <-> zesty-models/*.json <-> live models (stops the run on a mismatch)
  fetch.js              the Traction Rec "source": fetchAll() + fetchByIds(tier, ids)
  plan.js               pure: rows, relations, values, hash, active/inactive -> create/update/unchanged
  pages.js              catalog page items: create missing ones, follow renames (title only)
  write.js              dataset item create / update + publish
  values.js             Traction Rec value -> what a Zesty field type stores
  paths.js, hash.js     unique URL path parts; canonical hash
  run.js                one run (below)
src/tractionrec/        OAuth client_credentials client, SOQL, fetchTier (gates, junction, prices)
src/zesty/              SDK connection, model + item indexes
src/parsley-runner.js   /test-page/'s live Parsley runner (dev tool, unrelated to the sync)
zesty-models/*.json     the nine dataset specs, numbered in creation order (read at runtime)
centers.yaml            the centers: settings only, one entry each (rule 8)
.github/workflows/      deploy.yml: tests every pull request, deploys every merge into main
.gcloudignore           what a deploy leaves out: it uploads src/, zesty-models/, centers.yaml, package files
deploy/                 deploy.sh (every deploy step, rerunnable), config.sh (names),
                        center-secrets.sh (a center's 3 passwords, prompted),
                        secrets.sh (the trigger key), alerts.sh (email alert)
test/                   unit tests (npm test) + scenarios/ (live, see §6)
archive/file-sync/      the archived file sync (README there)
```

## 2. What a run does

1. **Checks the schema.** The definitions are checked against the specs, and
   the specs against the live models. Any mismatch stops the run before a
   write.
2. **Reads Traction Rec's published set in full** (the six tiers through their
   gates, plus price levels, billing schedules and Products). **Never
   incrementally:** the class gate is a time-based formula (below).
3. **Per dataset, in dependency order:**
   - finds the known ids that are not published now (its items, plus, for
     catalog datasets, their page items);
   - re-reads those from Traction Rec without the gate;
   - creates missing page items;
   - plans every row;
   - writes and publishes only what changed;
   - pushes renames to the pages.
4. Returns a report: per dataset, `created / updated / unchanged`,
   `active / inactive`, `deactivated / reactivated`,
   `pagesCreated / pagesRenamed`, `warnings`, `errors`, plus `errorCount`.
   **Alert on `errorCount`, not on the HTTP status.**

Timing: a quiet run takes about 16 s and writes nothing. The run
that added the lifecycle fields to every item took 297 s. The function limit is
540 s.

## 3. Rules (each a decision or learned the hard way)

1. **Nothing is ever deleted**. A record that
   leaves the published set becomes **`active = 0`** with an
   **`inactive_reason`**, on all nine datasets. Ways to leave:
   - its registration window closes;
   - it's set Not Available;
   - it's removed from Traction Rec;
   - it loses its required parent.

   The site hides inactive rows from listings. An inactive class page stays and
   reads "Registration closed". If the record comes back, it flips to
   `active = 1`.
2. **The class gate is a formula, `TREX1__Course_Online_Availability__c`**:
   empty = registrable online. It changes by **time**, when a registration
   window opens or closes, without the record being modified. So every run re-reads the full set. Its text is the
   `inactive_reason`.
3. **Relations are checked by the sync.** Zesty validates nothing (a
   one-to-one accepts any string). An unresolved required parent makes the
   row inactive and **keeps its old relation**; it is never guessed.
   Children keep resolving to an inactive parent.
4. **Change detection:** `sync_hash` on each item covers every field the sync
   writes, relations and `active` included. Equal hash = no write (each save
   is a new item version).
   - Values are compared, not Salesforce modstamps, so spot counts and gate
     changes are caught.
   - An editor's edit to a dataset item survives until that record next
     changes in Traction Rec.
5. **Page items** (models `categories`, `programs`, `courses`, `classes`):
   - **Created** for a published record whose parent has a page. Contents:
     `tractionrec_id`, the title field, and `web.pathPart` / `metaTitle` /
     `metaLinkText`. **No `parentZUID`:** every catalog page sits at the root,
     like the 300+ existing ones; a `parentZUID` nests the URL.
   - **Nothing else from Traction Rec is copied into page fields.** The site
     reads the `tr_*` rows.
   - **On a rename**, only the title field, `metaTitle` and `metaLinkText`
     follow.
   - ⚠ **The URL slug and anything else sensitive are never changed**:
     a changed URL breaks every link to the page. A
     renamed class keeps its original URL.
   - The page models' editorial fields are **not required**, so pages are created without placeholder values. Leave them
     optional.
6. **The schema is created by hand, never by the sync.** Edit
   `zesty-models/*.json`, create or extend with the site repo's
   `zesty-model.mjs`, then map in `definitions.js`. `npm test` fails until
   the definitions and specs agree.
7. **Dry-run first.** `.env` has `DRY_RUN=1`, so `npm run sync` only plans.
   Read the plan, then `npm run sync -- --live`.
8. **One run = one center.** A center is:
   - **an entry in `centers.yaml`**: name, Traction Rec org URL (+ optional
     API version), Zesty instance ZUID, schedule (cron + IANA time zone). No
     passwords. `npm test` validates every entry. A center exists when it has
     an entry; the function ships with the file;
   - **three Secret Manager secrets**, `center-<id>-tr-client-id`,
     `center-<id>-tr-client-secret` and `center-<id>-zesty-token`, read by
     name when a run starts (so a new value needs no deploy). Set with
     `deploy/center-secrets.sh <id>` or the Console; never in a file. The
     runtime account may read any `center-*` secret (one conditional grant).

   The HTTP call must name its center (`?center=<id>`): none → 400, not in
   `centers.yaml` → 404, a missing secret → 500 naming it. Every log line of a
   run carries `center`, and so does the report. Locally, `--center=<id>`
   reads the same entry and secrets (through your gcloud sign-in); without it
   the CLI uses `.env` alone (the scenario and live-cache tests still do).
   - **Each center needs its own Zesty instance built from the template** (the
     nine `tr_*` models from `zesty-models/`, the four page models, optional
     editorial fields) and a read-only Traction Rec integration user.
   - **Two runs of the same center must never overlap** (they could create the
     same item twice). Runs for different centers write to different instances
     and can't collide; the function still takes one request at a time, and
     the time zones spread the jobs out.
   - `phoenix-2` is a **test copy** of Phoenix (same org, same instance, so its
     runs write nothing new). Remove it once a real second center exists:
     delete its entry (the merge deletes its job), then its three secrets.
9. **Changes reach Google Cloud by merging into `main`**, never from a laptop:
   the workflow verifies the secrets, deploys, reconciles the jobs with
   `centers.yaml` (deleting the jobs of removed centers) and dry-runs every
   center. `deploy/deploy.sh` stays for one-time setup and emergencies.

## 4. Commands

```
npm run sync:dry -- --summary                      # plan only, counts per dataset (.env)
npm run sync:dry -- --center=phoenix --summary     # the same for one center (centers.yaml + its secrets)
npm run sync -- --live --summary                   # write + publish
npm run sync -- --live --datasets=tr_classes,tr_price_levels
npm test                                           # unit tests (54)
npm run test:scenarios                 # the real sync vs the real instance, simulated Traction Rec (§5)
npm run test:live-cache                # does a published change reach the LIVE pages? (§5)
npm run runner                         # /test-page/'s Parsley runner (127.0.0.1:8787)
npm start                              # the function locally (functions-framework)
```

## 5. Deploy

**Deployed and running daily, one job per center. Deploys come from GitHub
Actions on every merge into `main`** ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)).

| | |
| --- | --- |
| Project | `kroc-services` (number 1029593951118), region `us-west1` |
| Function | `kroc-tractionrec-sync` (Cloud Run functions, gen 2, nodejs22), URL `https://us-west1-kroc-services.cloudfunctions.net/kroc-tractionrec-sync` (Cloud Run: `https://kroc-tractionrec-sync-aswjekxq4q-uw.a.run.app`) |
| Runs as | `kroc-sync-runtime@kroc-services.iam.gserviceaccount.com`, which can read only the secrets below |
| Deploys as | `kroc-sync-deployer@kroc-services.iam.gserviceaccount.com`, through Workload Identity Federation (pool `github`, provider `github`), limited to `TSAUSN/Tractionrec-Sync-Services` on `main`. No key exists. It can deploy the function, manage Scheduler jobs, see secret names, read the trigger key and call the function; not read center passwords |
| Secrets (Secret Manager) | `sync-trigger-key` (bound at deploy as `SYNC_TRIGGER_KEY`; `deploy/secrets.sh`) and three per center, `center-<id>-{tr-client-id,tr-client-secret,zesty-token}` (read per run; `deploy/center-secrets.sh`) |
| Alert | Cloud Monitoring policy "kroc-tractionrec-sync: run errors" → email to `ALERT_EMAIL` (`deploy/config.sh`), created by `deploy/alerts.sh`. Fires on a run with `errorCount > 0`, `sync.failed`, any ERROR line from the function, or a failed Scheduler call; at most one email per 5 min. Tested with a deliberately invalid run (HTTP 500, `sync.failed`) |
| Schedule | one Cloud Scheduler job per center, `kroc-tractionrec-sync-<id>` (us-west1), at its `schedule` in `centers.yaml`: `phoenix` **00:00 America/Phoenix**, `phoenix-2` 00:30 America/Los_Angeles. POST `/?center=<id>`, OIDC as `kroc-sync-scheduler@kroc-services.iam.gserviceaccount.com` (the only account with `run.invoker` on the function) + `X-Sync-Key`; 600 s deadline, 3 retries 5 min apart |

**Verified on deploy:**
- **Auth:** no identity → 403; identity without the key → 403; both → 200.
- **A dry run** over HTTP: 6.5 s, 0 errors.
- **A forced Scheduler run:** POST 200, a live sync, 0 errors, 7 s.
- **Two centers:** each job's forced run returned 200 with 0 errors, logged
  under its own `center`. Fired at the same moment, the second request
  waited for the first and both returned 200; no retry was needed.
- **Live cache:** `npm run test:live-cache` after the site was published.
  Both live pages were cached by Varnish (`HIT`), yet a published row change
  showed on them after ~12 s, and the sync's restore showed at once.
  Publishing a `tr_*` item clears the cached pages that print it.

**Deploying: merge into `main`** (guide for people:
[deploy/README.md](deploy/README.md)). The workflow runs `npm test` on every
pull request and, on a merge, `bash deploy/deploy.sh verify function schedule
check` as the deployer. Every step checks what exists and only creates or
updates what's missing or different, so any step is safe to rerun by hand.
Names (project, region, accounts, the trusted repo, job prefix, alert email)
are in `deploy/config.sh`.

| Step | Does | Run by |
| --- | --- | --- |
| `apis` | turns on the Google Cloud products the sync and the GitHub trust use | Owner, once |
| `accounts` | `kroc-sync-runtime` (the function), `kroc-sync-scheduler` (calls it), `kroc-sync-deployer` (GitHub Actions) | Owner, once |
| `access` | runtime: read `center-*` secrets (conditional grant) and the trigger key; deployer: the roles above, and act-as the runtime, scheduler and build accounts | Owner, once |
| `github` | the Workload Identity pool + provider (only this repo's `main`), and the deployer binding | Owner, once |
| `secrets` | `deploy/secrets.sh`: the trigger key | Owner, once |
| `invoker` | `run.invoker` on the function for the scheduler and the deployer | Owner, once |
| `alerts` | `deploy/alerts.sh` | Owner, once |
| `verify` | every center in `centers.yaml` has its three secrets; stops before anything changes | every merge |
| `function` | deploys this folder (with `centers.yaml`) with the flags below | every merge |
| `schedule` | one job per center; deletes a job whose center left `centers.yaml`. The audience comes from the function's URL and `X-Sync-Key` from Secret Manager | every merge |
| `check` | a dry run per center over HTTP (`?center=<id>&dry=1`); fails unless each returns its center and `errorCount` 0 | every merge |

```
bash deploy/deploy.sh apis accounts access github secrets invoker alerts   # one-time setup (Owner)
bash deploy/center-secrets.sh <id>       # a center's passwords (then a PR adding its entry)
bash deploy/deploy.sh check              # dry-run every center now, as you
bash deploy/secrets.sh --rotate-key && bash deploy/deploy.sh function schedule check   # new trigger key
```

A function deploy takes about 1.5 minutes. The flags it uses, and why:

- **`DRY_RUN=0` is required.** Its default is 1, which plans and writes
  nothing, so a deploy without it looks healthy but does nothing.
- **`--max-instances=1 --concurrency=1`:** the code has no lock. Two
  overlapping runs of one center would each see a new record as missing and
  create it twice (item and page). One instance, one request at a time,
  prevents that; a request arriving during a run waits for it. The caller
  should also not fire a new run while one is still going.
- **`--timeout=540s`** covers the slowest run seen: 297 s, the one-off that
  added the lifecycle fields to every item. A quiet run takes about 16–22 s.
- **The caller** (the Scheduler job) needs `roles/run.invoker` on the
  function. It sends an OIDC identity token **and** `X-Sync-Key`. Alerting
  should key off the report's `errorCount`, not the HTTP status: a partial
  failure still returns 200. Required query: `?center=<id>`; optional
  `&datasets=tr_classes,…&dry=1`. To run one center now:
  `gcloud scheduler jobs run kroc-tractionrec-sync-<id> --location=us-west1`.
- **Logs:** Cloud Logging, `resource.labels.service_name="kroc-tractionrec-sync"`.
  Each run logs `sync.start` and `sync.done` (`errorCount`, `durationMs`)
  plus one line per dataset, every line with `center`; filter one with
  `jsonPayload.center="phoenix"`.
- **`.gcloudignore`** uploads only `src/`, `zesty-models/`, `centers.yaml` and
  the package files. Keep `zesty-models/` (the function reads the specs at
  runtime for its schema check) and `centers.yaml` (the center list); runs
  fail without them. `.env` and the credential file the GitHub auth step
  writes into the workspace (`gha-creds-*.json`) are never uploaded.
- **The Zesty token** must be an instance access token, not a person's
  session token. The current one is a 49-character key, not a session JWT;
  confirm in the Manager that it has no expiry and only the rights it needs.
- **Center passwords** are read with `@google-cloud/secret-manager` at the
  start of each run (`GCP_PROJECT` names the project). Only the trigger key
  arrives as an environment variable through `--set-secrets`.

## 6. Tests

- **Unit** (`test/*.test.js`): value conversion, definitions ↔ specs, the
  plan (create / update / unchanged / every lifecycle case / renames), pages,
  paths.
- **Scenarios** (`test/scenarios/run.js`): the integration user can't write
  to Traction Rec, so the harness:
  - reads the real published set;
  - adds a hand-written SIMTEST set (program, courses, classes, prices,
    membership type);
  - changes it step by step, running the **real sync against the real
    instance** after each step;
  - asserts the dataset items, the page items and the stage pages.

  The 13 steps: create, zero-write repeat, field + price change, rename (slug
  kept), re-parent, registration closes, comes back, removed, lost parent,
  membership not sold, derived rows, steady state, cleanup + real run. All 13
  passed. It deletes every SIMTEST item at the end, and at the
  start if a run stopped half way.
- **Live cache** (`test/scenarios/live-cache.js`): checks that a published
  dataset change reaches the **live** pages through their Varnish cache, then
  that the sync's restore does too. **Not run yet:** it needs the site code
  published to the live domain first.

## 7. Facts the design rests on (verified on this instance)

- Zesty field limits:
  - `text` max 150 characters;
  - an empty number must be `null` (`""` gives a 500);
  - an omitted `yes_no` is stored as 0;
  - `one_to_one` holds one ZUID, unvalidated.

  See `docs/dataset-storage.md` §1.
- Item writes: an SDK create is listed by default; an update needs
  `meta.listed: true` and returns its new version; the live domain shows only
  published versions.
- Parsley reads the datasets with native loops (`where`, `sort`, `limit`
  work); `filter()` reads single values.
- The stage domain renders unpublished drafts. The live domain sits behind
  two Varnish layers that cache pages even with `cache-control: no-cache`.
- `/test-page/` (the site repo's `webengine/views/test_page`) is the Parsley
  capability matrix plus the live runner. Its `/tractionrec/` file examples
  were removed with the file sync. The runner writes a **draft** of
  `/_runner/run.html` and renders it on stage inside the test page.

## 8. Open items

- The org's daily API budget is unknown (`/limits` is disabled for the
  integration user). A run is about 11 Traction Rec calls, plus one per 200
  re-read ids. Once a day is well within any normal budget.
- The old `/tractionrec/*.json` views are still on the instance, unread.
  Delete them in the Manager when convenient.
- Mirror fields on the page models (the old copied Traction Rec values) are
  no longer written. Removing them from the models is a later step.
- Traction Rec admin: tag Kickball and Corps Programs (inactive for lack of a
  category); add a membership purchase-link field.
- Sandbox → production Traction Rec changes every Salesforce Id: plan a clean
  rebuild before launch.

## 9. Docs

| Doc | |
| --- | --- |
| [docs/dataset-sync.md](docs/dataset-sync.md) | reviewer report: the sync, the mapping, how the site uses it |
| [docs/dataset-storage.md](docs/dataset-storage.md) | the design and the instance measurements behind it, the model tree, the browser-fetch option, the field appendix |
| [archive/file-sync/](archive/file-sync/README.md) | the archived file sync and its docs |
