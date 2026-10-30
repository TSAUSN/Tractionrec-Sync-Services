# kroc-tractionrec-sync

A scheduled, one-way sync from **Traction Rec** (Salesforce) into the **KROC
Zesty WebEngine** instance. Runs as a Google Cloud Function on a Cloud
Scheduler cron.

It does two things per Traction Rec record:

1. writes the record to a JSON view at **`tractionrec/<tier>/<tractionRecId>.json`**, and
2. makes sure a Zesty content item exists carrying that record's Id in a
   **`tractionrec_id`** field.

The item and the file are the two halves of one class. The id field is the
hinge between them: from an item you can compute its snapshot's URL, and the
snapshot records the item's ZUID.

```
Traction Rec ──► [ sync ] ──► tractionrec/classes/a0X….json     ← this service owns it
                     │
                     └──────► classes item, tractionrec_id=a0X…  ← editors own it
```

**The service creates items; it never updates them.** After an item exists, the
only thing that changes is the snapshot file. That is what keeps the CMS
genuinely editable — otherwise every run at 3am would revert whatever an editor
changed that afternoon.

**Nothing is ever deleted.** A Traction Rec record with no Zesty item gets one.
A Zesty item with no Traction Rec record is *reported*, and left exactly where
it is.

---

## Why this exists

A Zesty view cannot call Traction Rec, so something outside Zesty has to.

⚠️ **The reason recorded in the spec is wrong** (corrected 2026-09-30). It says
Parsley has no outbound HTTP. Parsley *does* — `api.json.get(url)` fetches any
URL server-side, including external domains. The real blockers are narrower and
still decisive:

- `api.json.get()` sends **no headers**, and Traction Rec returns 401 for
  `?access_token=` in the query string (verified).
- Minting a token is a **POST**; `api.json.get()` is GET-only.
- A Zesty view is a **public URL**, so the client secret could never live in one.
- The Integration field was tested and rejected separately: it puts the bearer
  token in a field config any CMS user can read, and the `client_credentials`
  session has no refresh token, so it dies every couple of hours.

So the service is still the only option — but Parsley *can* read the JSON this
service publishes, which is what
[relationships-without-zesty-fields.md](docs/relationships-without-zesty-fields.md)
builds on. Full argument: `KROC-draft/tractionrec-integration-spec.md`.

---

## Documentation

| | |
| :--- | :--- |
| [docs/how-it-works.md](docs/how-it-works.md) | one-page, non-technical overview for executives: how the sync works, who edits what, the constraints |
| [docs/tractionrec-in-zesty.md](docs/tractionrec-in-zesty.md) | technical, end to end: each tier from Traction Rec object to file to Zesty model/block to page, and how memberships (files only) differ from the catalog |
| [docs/dataset-sync.md](docs/dataset-sync.md) | review report: the new dataset sync, how Traction Rec maps onto the `tr_*` datasets, and how the site uses them; verification and open items |
| [docs/dataset-storage.md](docs/dataset-storage.md) | built 2026-10-19; the site reads the datasets since 2026-10-20; the dataset sync runs locally, not deployed: storing Traction Rec as Zesty datasets (child datasets, one-to-one relations) instead of files. Probe results, the model tree and what the sync and site would change; specs in [zesty-models/](zesty-models/) |
| [AGENTS.md](AGENTS.md) | **start here** — the current output shape, the rules, commands, verified facts and open items, in one page |
| [docs/sync-flow.md](docs/sync-flow.md) | how a run works, the reconcile decision table, change detection, the freshness trade-off, the pre-flight checklist |
| [docs/data-mapping.md](docs/data-mapping.md) | Traction Rec object → Zesty model → snapshot shape, field by field, plus the gaps in the source data |
| [docs/operations.md](docs/operations.md) | secrets, deploy, schedule, reading a run report, failure modes |
| [docs/relationships-without-zesty-fields.md](docs/relationships-without-zesty-fields.md) | the design: relationships from the synced files instead of Zesty relational fields; what Parsley can read (§2.0a) and the tier / children files (§2.0, §2.0c). Tier and children files are implemented; removing the relational fields is not yet |

---

## Quick start

```bash
npm install
cp .env.example .env        # fill in; .env is gitignored

npm run sync:dry            # plan every tier, write nothing
npm test                    # the reconcile decision table
npm run runner              # live Parsley runner for /test-page/ (local only)
npm run datasets:dry -- --summary   # dataset sync (tr_* datasets): plan only
```

Then, once a dry run reads correctly:

```bash
node src/cli.js --tiers=program_categories --live   # 9 records — the safest first write
```

> **Before the first live run** the `tractionrec_id` field has to exist on the
> `categories`, `programs`, `courses` and `classes` models, and the pageset
> parent behaviour needs one hand-made item to compare against. Full list:
> [sync-flow.md §7](docs/sync-flow.md#7-what-has-to-exist-before-the-first-run).

---

## Layout

```
src/
  index.js              Cloud Function entry point (HTTP, guarded by X-Sync-Key)
  cli.js                local runner — reads .env, supports --tiers / --dry / --live
  reset.js              deletes the /tractionrec/ views (and, opt-in, the items)
  parsley-runner.js     dev tool: runs edited Parsley from /test-page/ on stage
  config.js             the tier map: TR object ↔ Zesty model ↔ fields. Start here
  logger.js             JSON lines, so Cloud Logging gets queryable fields
  tractionrec/
    auth.js             OAuth client_credentials (no refresh token exists)
    client.js           SOQL + pagination + retry + re-auth on a dead session
    fetch-tier.js       one tier's records, plus junction and price lookups
  zesty/
    client.js           SDK wrapper; turns non-2xx responses into throws
    items.js            index items by tractionrec_id; create + publish
    views.js            snapshot writer; Parsley-safe JSON; create/update + publish
  sync/
    shape.js            Salesforce record at the root + meta; canonical hash
    reconcile.js        the decision table, as a pure function
    tier-files.js       /tractionrec/<tier>.json; writes derived files only when changed
    children-files.js   /tractionrec/<parent>/<id>/<children>.json, rebuilt every run
    state.js            the hash ledger, stored as a view in the instance
    run.js              the orchestrator
test/
  reconcile.test.js     the decision table, asserted case by case
  views.test.js         Parsley escaping and snapshot paths
```

`src/sync/reconcile.js` is the file to read if you only read one. It does no
I/O, so the entire create/refresh/orphan/conflict policy is visible in one
place and testable without touching either API.
