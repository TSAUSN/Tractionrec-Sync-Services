# AGENTS.md — kroc-tractionrec-sync

Read this before changing anything here. It records how the service works
**now** and the decisions behind it. The `docs/` files have the full
reasoning and history; this file is the current state.

**What this is:** a Google Cloud Function (Node 22) that copies the Traction
Rec catalog into the KROC Zesty instance (`8-80c0bba6b8-lhkcc7`, served at
`kroc.zesty.dev`). Traction Rec is a Salesforce managed package
(`TREX1__…` objects) and is the system of record. The service writes two things
(memberships only the first, see below):

1. **JSON views under `/tractionrec/`**, Salesforce's records verbatim. The
   website reads these files (JavaScript in Kroc-Center-Template's
   components, or Parsley's `api.json.get`).
2. **One Zesty content item per record**, carrying its Salesforce Id in a
   `tractionrec_id` field. Zesty owns the URL, layout and editorial content;
   the item is the page.

The site repo is `../Kroc-Center-Template` (see its `AGENTS.md`); design and
architecture docs are in `../KROC-draft`.

---

## 1. What it writes (current shape, 2026-10-02)

```
/tractionrec/
├── _sync-state.json                         ledger: record hashes, file hashes, last run
├── program_categories.json                  every record of a tier, root array
├── programs.json · courses.json · classes.json
├── program_categories/{id}.json             one record
├── program_categories/{id}/programs.json    that category's programs   (children file)
├── programs/{id}.json
├── programs/{id}/courses.json               that program's courses     (children file)
├── courses/{id}.json
├── courses/{id}/classes.json                that course's classes      (children file)
├── classes/{id}.json
├── membership_categories.json · membership_types.json
├── membership_categories/{id}.json
├── membership_categories/{id}/membership_types.json
└── membership_types/{id}.json
```

Catalog (2026-10-05): 364 files, 212 records (9 / 20 / 118 / 65), 4 tier files,
147 children files and the ledger. Memberships (2026-10-08): 7 categories, 24
types, 2 tier files, 7 children files (3 of them `[]`).

**Memberships are files only** (Japheth, 2026-10-08). Their tiers set
`filesOnly: true` and have no `zestyModel`: no items are created or linked, so
their rows carry no `meta.zestyItemZuid` / `zestyPath`. The design never gives
a membership its own page; the site's `[membership_tiers]` and
`[day_pass_passes]` rows point at a type by `tractionrec_id` and inline
`membership_types.json`. Gate: the type **and** its category must be available
online and for purchase (a type's own flag misfires inside offline categories).

**Row shape.** Every file holds the same row objects: Salesforce's fields at
the **root**, untouched apart from the API's `attributes` envelope, and the
sync's bookkeeping under `meta`:

```json
{ "Id": "a1za…", "Name": "…", "TREX1__Program__c": "a31a…",
  "meta": { "tier": "courses", "tractionrecId": "a1za…", "zestyItemZuid": "7-…",
            "zestyPath": "/learn-to-swim-level-2/",
            "hash": "sha256:…", "syncedAt": "…", "sourceModstamp": "…" } }
```

The sync adds two keys beside Salesforce's: `TREX1__Program_Category__c` on
programs (an array of category ids, from the junction object) and `prices` on
classes and membership types (Price Level rows; on membership types each level
also carries `schedules`, its Planned Billing Schedules, because that is where
an Autopay membership's monthly amount lives — see `docs/data-mapping.md`). A Salesforce field that would collide with an
added key makes the sync throw rather than overwrite.

**Children files.** Every synced parent gets one, `[]` when it has no
children (88 do). Each is rebuilt from all rows on every run, never patched,
which is what keeps many-to-many (category ↔ program) correct when a program
is untagged. Rows are full copies, sorted by name then Id.

**`meta.zestyPath`** (2026-10-05) is the URL of the row's Zesty page; the
site's catalog cards link with it. A URL changed in the Manager reaches the
files on the next run: the ledger key for a record file is
`fileKey` = hash(record hash, item ZUID, path).

**Inline-safe.** Files are written with `{{` as `\u007b\u007b` and `</` as `<\/`
(`parsleySafeJson`), so a page can `{{ include }}` one inside a
`<script type="application/json">` without Parsley or the HTML parser touching it.

**Writes happen only on change.** Record files are compared by `fileKey`.
Tier and children files by a hash of their rows' hashes, Zesty items and
order (not `syncedAt`). A hash only counts while its file still exists. A run
with no Traction Rec changes writes nothing; check this after any change.

## 2. Rules (each was decided or learned the hard way)

1. **Never hand-write anything under `/tractionrec/`**, on the instance or in
   Kroc-Center-Template's local `webengine/views/tractionrec/` (gitignored
   there). Change the code, then re-run the sync. To restructure the output:
   `npm run reset:live`, then a live sync.
2. **Items are created once, never updated, never deleted.** No automatic
   deletion, ever: Japheth's explicit rule. An item may have gained editorial
   content and owns an indexed URL. `reset` deletes items only with
   `--items`, and never one without a `tractionrec_id`.
3. **Keep Traction Rec's data and naming verbatim.** No renaming, no
   flattening. Nested `__r` objects stay nested and **JavaScript reads them**
   (decided 2026-10-02: no flat projection for Parsley).
4. **Don't copy Traction Rec data into Zesty fields** beyond `tractionrec_id`
   and the web/SEO identity Zesty owns. A field that looks editable but isn't
   misleads editors (direction set 2026-09-30). Relationships come from the
   records in the files, not Zesty relational fields. The sync still seeds
   the old relational fields on create; removing that is pending
   (`docs/relationships-without-zesty-fields.md` §3–6).
5. **Plural, REST-style names everywhere.** The tier keys are
   `program_categories`, `programs`, `courses`, `classes`,
   `membership_categories`, `membership_types`. The same word is
   the folder, `--tiers=…`, `SYNC_TIERS`, `SEED_TEMPLATE_ITEMS` and `meta.tier`.
   A child collection lives under its parent (`programs/{id}/courses.json`).
   The child tier's key *is* the children file's name.
6. **Secrets stay server-side.** The Salesforce client secret and tokens, and
   the Zesty token, never go in a view (views are public URLs), a browser
   bundle, or a Zesty Integration field. The Traction Rec credential is not
   harmless: it reads 315 objects, including about 5,500 staff records with
   emails and phones. `.env` is gitignored; never print or commit it.
7. **Dry-run first.** `.env` has `DRY_RUN=1`, so `npm run sync` only plans.
   Live: `DRY_RUN=0 npm run sync`. Show the plan before any live run that
   deletes.
8. **Commit messages carry no AI attribution** (Japheth's rule).

## 3. Commands

```bash
npm test                         # node --test; must stay green
npm run sync                     # DRY RUN while .env has DRY_RUN=1
DRY_RUN=0 npm run sync           # live: ~4 min into an empty folder, seconds when quiet
node src/cli.js --tiers=classes  # some tiers; missing tiers are read back from their tier files
npm run reset                    # plan: lists every view it would delete
npm run reset:live               # delete every view under /tractionrec/ (items untouched)
npm run runner                   # live Parsley runner for /test-page/ (local only, 127.0.0.1:8787)
npm run datasets:dry -- --summary      # dataset sync (tr_* models), plan only
npm run datasets -- --live --summary   # dataset sync, write + publish (~3.5 min first run, ~14 s quiet)
```

**After changing what the sync writes**, check in this order: tests →
dry run → reset if the paths or shape changed → live sync → a second dry run
must plan **0 writes** → fetch a few files from `https://kroc.zesty.dev/tractionrec/…`
→ `/test-page/` renders. In the site repo, the Zesty extension pulls the
generated files down; don't push them.

## 4. Code map

```
src/config.js               TIERS: the one Traction Rec ↔ Zesty mapping. Start here.
                            `filesOnly` tiers (memberships) have no Zesty model
src/cli.js · src/index.js   local runner · Cloud Function entry (X-Sync-Key)
src/sync/run.js             orchestrator: tiers in order, then children files, then ledger
src/sync/reconcile.js       pure decision table: create / refresh / unchanged / conflict / orphan
src/sync/shape.js           buildSnapshot (root-level record + meta), canonical hash
src/sync/tier-files.js      <tier>.json; writeDerivedFile (hash-checked writes)
src/sync/children-files.js  <parentTier>/<id>/<childTier>.json, pure builder
src/sync/seed.js · paths.js item payload on create · unique URL path parts
src/sync/state.js           the ledger, itself a view
src/zesty/views.js          writeSnapshot, parsleySafeJson, viewPath, indexViewRows
src/zesty/items.js          index items by tractionrec_id; create + publish
src/tractionrec/*           OAuth client_credentials, SOQL, junction + price lookups
src/reset.js                deletes the views (and, opt-in, items)
src/parsley-runner.js       the test page's runner (§6)
src/datasets/*              the DATASET sync (Traction Rec -> tr_* Zesty datasets), separate
                            from src/sync/ and sharing only config + the Traction Rec side;
                            docs/dataset-storage.md §3
docs/                       tractionrec-in-zesty.md (end to end, catalog vs memberships),
                            relationships-without-zesty-fields.md (the design, §2.0–2.0c),
                            sync-flow.md, data-mapping.md, operations.md
                            dataset-sync.md (review report: the dataset sync, mapping, site use),
                            dataset-storage.md (datasets instead of files: built, the site reads them since
                            2026-10-20; the dataset sync is not deployed)
zesty-models/               create specs for those datasets, numbered in creation order
docs/backups/               the original test_page.integration_test value (§6)
```

## 5. Facts the design rests on (all verified on this instance)

**Parsley reading these files** (details in docs §2.0a and the site repo's AGENTS §3):

- `{{each api.json.get(FULL_URL) as r}}` fetches any URL server-side.
  It must be a full URL inside an `each`; a missing URL gives one empty pass
  with no error.
- **It reads one level deep only.** `{{r.Name}}` works. A dotted read
  (`{{r.a.b}}`) or printing an object **crashes the whole page**, and an array
  prints as `Array`. That's why the fields are at the root, and why class
  `__r` fields, `prices` and the category array are JavaScript-only.
- `where` and `limit` are ignored on a fetched loop; filter with an inner
  `{{if}}`. **Hyphen trap:** `== (value)` in parentheses fails silently if the
  value has a hyphen. That's safe for Salesforce ids, not for Zesty ZUIDs;
  quote those instead.
- Inside a fetched loop, an outer loop's alias is gone (and `c.getUrl()`
  returns the *current* page). A loop alias does work inside an
  `api.json.get` URL, but one fetch per row is slow: 71 s for 119 courses.
  That's why the children files exist.
- `{{ include /path.json }}` inlines a file as raw text, a payload for
  JavaScript rather than markup.

**Zesty views API:**

- A view's filename **needs a leading slash**. Without it the API accepts it,
  reports it live, and it 404s.
- `/web/views` returns one row per status (`dev`, `live`) with different
  versions; keep the highest.
- `updateView` does not return the new version. Read it back before
  `publishView`, or the old version is re-published. This bug left every
  refresh stale until 2026-09-30.
- Views are Parsley-processed, so a literal `{{` in content is rewritten by
  `parsleySafeJson`. There is no `deleteView` in the SDK, but
  `DELETE /web/views/{zuid}` works.
- The stage domain `https://6wz46m14-dev.webengine.zesty.io` renders
  **unpublished drafts**. A Parsley crash there is an HTTP 500 with no detail.
- The catalog models share one URL namespace, so path parts must be unique
  across all four (`paths.js`).

**Traction Rec:** the category ↔ program link (`TREX1__Program_Category_Tag__c`)
carries no data of its own (2026-10-02). If it gains a per-link field such as
display order, the children-file design must change. No program is in more
than one category today, so the unit tests cover many-to-many with fixtures.

## 6. The test page and runner

`/test-page/` on the instance (view `11-baceb384c2-z3nhdd`; the site repo's
`webengine/views/test_page`) is the living proof of everything above:
- **Part 1** has §0–§7: relationships without Zesty fields, with
  `api.json.get`, per-row fetches, and children files.
- **Part 2** is the Parsley capability matrix.

Every code block is editable and runs through `npm run runner`. The runner
writes the code as a **draft** of `/_runner/run.html` and renders it on stage
inside the test page, so `this` is that page's item. It never publishes. It
binds to 127.0.0.1 and only accepts the instance's own origins.

Part 2 §A–B read the page's `integration_test` field, which holds test data.
The original value (one class record, no secrets) is in
`docs/backups/test_page.integration_test.original.json`. Restoring it breaks
those rows.

## 7. Open items

- **Relational fields:** the site's catalog pages read the files since
  2026-10-05 and ignore the mirrored Zesty fields; the sync still seeds those
  fields on create. Stop seeding them, then remove the fields (docs §3–6).
- **Freshness:** the volatile fields (spots, price, availability, deep link)
  are cached at cron cadence. See `docs/sync-flow.md` §6 before scheduling.
  The org's API budget is unknown (`/limits` is disabled for this user).
- **Seed template:** a temporary workaround that copies required-field values
  from one existing item per tier. Remove it once those fields stop being
  required.
- **Deploy:** gcloud deploy and Cloud Scheduler steps are in
  `docs/operations.md`. The first full run (230 s) fits the 540 s timeout.
