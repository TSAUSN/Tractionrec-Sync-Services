# kroc-tractionrec-sync

A one-way sync from **Traction Rec** (Salesforce) into the **KROC Zesty
WebEngine** instances, as an HTTP Google Cloud Function. It serves several Kroc
centers, each with its own Traction Rec org and Zesty instance: their
settings are in [centers.yaml](centers.yaml), their passwords in Secret
Manager. A Cloud Scheduler job per center calls it; it has no schedule of its
own.

Each call (`?center=<id>`), for that center:

1. copies Traction Rec's published catalog and memberships into **nine `tr_*`
   Zesty datasets**: one item per record, with relations between them;
2. creates the catalog's **page items** (one Zesty page per category, program,
   course and class) for new records, and keeps their titles in step with
   renames. **The URL is never changed.**

```
Traction Rec ──► [ sync ] ──► tr_* datasets (data, relations, active/inactive)   ← this service owns them
                     │
                     └──────► catalog page items (title, URL)                   ← editors own everything else
```

**Nothing is ever deleted.** A record that leaves Traction Rec's published set
is marked `active = 0` with the reason, and the site hides it. The site
(`../Kroc-Center-Template`) reads the datasets in Parsley, with no files and no
fetches.

## Why a service

A Zesty view can't call Traction Rec: Parsley's `api.json.get()` sends no
headers, minting a token is a POST, and a view is a public URL, so the client
secret could never live in one.

## Quick start

```bash
npm install
cp .env.example .env               # fill in; .env is gitignored

npm run sync:dry -- --summary      # plan, write nothing
npm test                           # unit tests
npm run sync -- --live --summary   # write + publish

# one center from centers.yaml (its passwords through your gcloud sign-in)
npm run sync:dry -- --center=phoenix --summary
```

## Deploy

**Merge into `main`.** GitHub Actions tests every pull request and, on a merge,
deploys the function, keeps one daily Scheduler job per center in step with
`centers.yaml`, and dry-runs every center. Adding a center is its three
passwords (`bash deploy/center-secrets.sh <id>`) plus a pull request adding its
entry. See [deploy/README.md](deploy/README.md).

## Documentation

| | |
| :--- | :--- |
| [AGENTS.md](AGENTS.md) | **start here**: what a run does, the rules, commands, tests, verified facts and open items, in one page |
| [deploy/README.md](deploy/README.md) | how to deploy, what gets created in Google Cloud, and the common tasks (redeploy, run now, rotate secrets, pause) |
| [docs/dataset-sync.md](docs/dataset-sync.md) | reviewer report: the sync, how Traction Rec maps onto the `tr_*` datasets, how the site uses them, verification and open items |
| [docs/dataset-storage.md](docs/dataset-storage.md) | the design and the instance measurements behind it, the model tree, the browser-fetch option for the class finder, the field appendix |
| [archive/file-sync/](archive/file-sync/README.md) | the first version, which wrote JSON files under `/tractionrec/`; archived, not used |
