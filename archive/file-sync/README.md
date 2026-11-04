# Archived: the file sync

*Archived.* This is the first version of the sync, kept for
reference. **It is not run, deployed, tested or imported by anything in the
repo.** The live sync is the dataset sync in `src/` (see the repo's
`AGENTS.md` and `docs/dataset-sync.md`).

## What it did

It read Traction Rec's published catalog and memberships and wrote them into the
Zesty instance as **JSON views** under `/tractionrec/`:
- one file per record;
- one per tier;
- one per parent's children.

The site's page views included or fetched those files. It also created one
Zesty **page item** per category, program, course and class, once, seeding
copies of some Traction Rec values into page fields.

## Why it was archived

The site moved to the `tr_*` Zesty datasets (one item per
record, relations between them). It was then decided to keep the
dataset architecture and retire this sync. The dataset sync took over both
jobs:
- the data, in datasets instead of files;
- the page items, created without copying Traction Rec values into page
  fields.

Its files on the instance (`/tractionrec/*.json`) are no longer read by the
site.

## What's here

| Path | |
| --- | --- |
| `src/` | the whole file sync as it was, self-contained: its own copies of the config, the Traction Rec client and the Zesty helpers it used, so nothing here depends on the live code (and the live code depends on nothing here) |
| `test/` | its unit tests |
| `docs/` | its docs: `sync-flow.md`, `data-mapping.md` (still the best field-by-field notes on Traction Rec's objects), `operations.md`, `relationships-without-zesty-fields.md`, `tractionrec-in-zesty.md`, `how-it-works.md` / `.docx`, `backups/` |
| `.env.example` | its settings (`SYNC_TIERS`, `CREATE_MISSING_ITEMS`, `SEED_TEMPLATE_ITEMS`) |

Its relative paths still work inside this folder. Running it would need the
`node_modules` from the repo root, and nothing should run it.
