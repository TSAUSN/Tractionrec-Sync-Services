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
Traction Rec ──► [ sync ] ──► tractionrec/class/a0X….json     ← this service owns it
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

Parsley has no outbound HTTP — it only templates over Zesty's own content
store — so a Zesty view cannot call Traction Rec. Zesty custom endpoints are
public URLs, so the Salesforce secret could not live in one regardless. The
Integration field was tested and rejected: it puts the bearer token in a field
config any CMS user can read, and the `client_credentials` session has no
refresh token, so it dies every couple of hours.

A service outside Zesty is not a preference. It is the only option. The full
argument is in `KROC-draft/tractionrec-integration-spec.md`.

---

## Documentation

| | |
| :--- | :--- |
| [docs/sync-flow.md](docs/sync-flow.md) | how a run works, the reconcile decision table, change detection, the freshness trade-off, the pre-flight checklist |
| [docs/data-mapping.md](docs/data-mapping.md) | Traction Rec object → Zesty model → snapshot shape, field by field, plus the gaps in the source data |
| [docs/operations.md](docs/operations.md) | secrets, deploy, schedule, reading a run report, failure modes |

---

## Quick start

```bash
npm install
cp .env.example .env        # fill in; .env is gitignored

npm run sync:dry            # plan every tier, write nothing
npm test                    # the reconcile decision table
```

Then, once a dry run reads correctly:

```bash
node src/cli.js --tiers=program_category --live   # 9 records — the safest first write
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
    shape.js            flatten a Salesforce record; canonical hash
    reconcile.js        the decision table, as a pure function
    state.js            the hash ledger, stored as a view in the instance
    run.js              the orchestrator
test/
  reconcile.test.js     the decision table, asserted case by case
  views.test.js         Parsley escaping and snapshot paths
```

`src/sync/reconcile.js` is the file to read if you only read one. It does no
I/O, so the entire create/refresh/orphan/conflict policy is visible in one
place and testable without touching either API.
