# Traction Rec → Zesty datasets: review report

*20 October 2026, updated 29 October · kroc-tractionrec-sync + Kroc-Center-Template*

## Summary

Traction Rec data used to reach the site as JSON files written into the Zesty
instance (`/tractionrec/*.json`), and the page templates read those files. It
now lives in **nine Zesty datasets** (`tr_*`), filled by a **new sync**. The
catalog pages and the membership blocks read those datasets directly in
Parsley.

- **The old file sync is archived** (`archive/file-sync/`, 2026-10-29). The
  new sync also took over its other job: creating the catalog's page items.
- **Records that leave Traction Rec are marked inactive, never deleted.** This
  covers a closed registration window, a removed record and a lost parent.
  The site hides them, and an inactive class page reads "Registration closed".
- **The site's look and behaviour are unchanged.** Captured before and after
  on desktop and mobile, every page matched, apart from data that had genuinely
  changed in Traction Rec since the files were last written.
- **No page fetches anything.** Each page gets its Traction Rec data in the
  HTML it is served.
- **Not deployed yet.** It's an HTTP Cloud Function that a separate service
  will call. Until then it runs from a developer machine, and the datasets
  refresh only when it's run.

## 1. The new sync

```
Traction Rec (Salesforce)
   │  read-only queries, same publishing gates as before
   ▼
the sync (kroc-tractionrec-sync, HTTP Cloud Function, called by a separate service)
   │  creates / updates + publishes items; creates catalog page items
   ▼
9 tr_* datasets in Zesty  ──▶  catalog pages + membership blocks (Parsley)
```

| Aspect | How it works |
| --- | --- |
| **Replaces the file sync** | The file sync is archived; this sync (`npm run sync`, or the HTTP function) uses the same Traction Rec queries and publishing gates. |
| **Schema stays reviewed** | The nine models were created by hand from spec files in `zesty-models/`. The sync never creates or changes a model. Before it writes, it checks that the live models still match the specs, and stops if they don't. |
| **Re-reads everything each run** | The class publishing gate is a time-based Traction Rec formula: a class leaves when its registration window closes, without being modified. So the whole published set is compared on every run; an incremental sync would miss it. |
| **Writes only what changed** | Each item stores a hash of its data. If the hash matches, nothing is written. A quiet run takes about 16 s and writes nothing. |
| **Never deletes: marks inactive** | Every dataset has `active` and `inactive_reason`. A record that leaves the published set becomes `active = 0`, with Traction Rec's own reason ("Outside Course Option Registration Timeframe"), "Removed from Traction Rec", or a missing parent. It flips back to active if it returns. |
| **Checks its own links** | Zesty doesn't validate relation fields, so the sync resolves every reference itself. A record whose required parent is missing becomes inactive and keeps its old link; it is never linked to a wrong item. |
| **Creates page items** | A new published category, program, course or class gets its Zesty page in the same run: title, URL slug and SEO title, at the root like the existing pages. On a rename only the title and SEO title follow. **The URL slug is never changed.** No other Traction Rec data is copied into page fields. |

**First run:** 360 items, created and published in 3.5 minutes. **Today:**

| | Active | Inactive |
| --- | --- | --- |
| Classes | 41 | 24 (registration windows closed, including 20 old class pages back-filled) |
| Programs | 20 | 2 (no category in Traction Rec) |
| Products | 44 | 4 (no longer used) |
| Price levels | 63 | 6 (no longer used) |

## 2. How the mapping works

**One Traction Rec record becomes one dataset item.** Each item keeps its
Salesforce Id (`tractionrec_id`). References to other records are **Zesty
relation fields**: they hold the related item, not a Traction Rec Id.

| Dataset | Traction Rec object | Items | Points to |
| --- | --- | --- | --- |
| `tr_program_categories` | Program Category | 9 | its Zesty page |
| `tr_programs` | Program | 20 | its categories (many), its page |
| `tr_courses` | Course | 118 | its program, its page |
| `tr_classes` | Course Session Option | 45 | its course, its product, its page |
| `tr_products` | Product | 48 | — |
| `tr_price_levels` | Price Level | 69 | its product |
| `tr_billing_schedules` | Planned Billing Schedule | 20 | its price level |
| `tr_membership_categories` | Membership Category | 7 | — |
| `tr_membership_types` | Membership Type | 24 | its category, its product |

```
categories ◀══ programs ◀── courses ◀── classes ──▶ products ◀── price levels ◀── billing schedules
                                                       ▲
membership categories ◀── membership types ────────────┘
```

**How Traction Rec's structure maps onto flat datasets:**

| Traction Rec shape | In Zesty | Why |
| --- | --- | --- |
| A record's own fields | fields on its item | readable names (`start_date`); each field's description names its Salesforce source |
| A parent lookup (course → program) | a **one-to-one** relation | the reference rides on Zesty's own link, not on an Id string |
| Many-to-many (program ↔ category) | a **one-to-many** relation on the program | no extra junction dataset |
| A list of child records (a product's prices, a price's billing schedule) | a **child dataset** with a relation back to its parent | lossless, and the server can loop it |
| A 1:1 related record (a class's Course Option, Session name) | **flattened** onto the item | no list to keep; a separate dataset would add a join for nothing |
| Prices | hang off the **Product**, as in Traction Rec | the 45 classes use only 24 products (45 price levels) between them, so storing prices per class would duplicate them |

**Values** are stored in the matching Zesty field type: text, long text,
number, currency, date, date-time (UTC), yes/no, link. The sync respects the
limits measured on the instance, for example 150 characters for a short text
field and never an empty string in a number field. Picklists and times are
kept as text, so a new value in Traction Rec can't break a write.

The full field list per dataset is in the appendix of
[dataset-storage.md](dataset-storage.md).

## 3. How the site uses it now

Each page finds its own dataset item through the **page relation**: the
dataset row points at the Zesty page it belongs to. From there it follows
relations to children and parents, all inside the page template on the
server.

| Page / block | Reads |
| --- | --- |
| Catalog root (`/categories-page/`) | all categories (the grid) + every class with its course, program, categories and prices (the class finder) |
| Category | the category + its programs |
| Program | the program + its courses and their classes + its category (breadcrumb) |
| Course | the course + its classes + the program's other courses + program and category (breadcrumbs) |
| Class | the class + its prices + the course's other **active** classes + course, program and category (breadcrumbs). An inactive class's page stays and reads "Registration closed" |
| `[membership_tiers]`, `[day_pass_passes]` | the membership types with their price levels and schedules; each card still picks its type by Traction Rec Id, because a repeater row can't hold a relation |

Every listing loops **active** rows only: the category's programs, the
program's courses and classes, the course's classes, the finder and the
membership cards.

**What changed for the site:**
- Pages print the rows they need straight into the page, so there are **no
  browser requests** for Traction Rec data, and the data is in the HTML
  search engines see.
- Card links and breadcrumbs come from each row's page relation, so a URL
  changed in the Manager is followed at once.
- One shared row template per dataset (`views/datasets/*.json`) keeps the
  five page templates from repeating the field list.
- The display code (cards, listings, detail pages) is unchanged; only the data
  layer under it was swapped.
- Zesty still owns what Traction Rec has no source for (hero images, icons,
  intro copy, class type, location, tags), and the "hide class pages" toggle on
  courses works as before.

**Cost:** detail pages render in about 1 s uncached. The catalog root, which
loads the whole catalog for its class finder, takes about 3 s uncached; the
live site caches it. That was accepted for now. The way to move the finder to
a browser fetch later is documented in [dataset-storage.md](dataset-storage.md)
§4.

## 4. Verification

| Check | Result |
| --- | --- |
| Live sync run, then a repeat | 360 created and published with 0 errors; the repeat wrote 0 |
| Update path | an item marked stale was updated and republished; the next run wrote 0 |
| Pages vs. before (desktop + mobile text captures) | identical, except Traction Rec data changes (classes that ended) |
| Class finder filters | counts match an independent server-side count |
| Membership blocks | identical: prices, family rules, `{fee}` fine print |
| Hidden class pages | still redirect to their course |
| Lifecycle run (2026-10-29) | every item gained `active` / `inactive_reason`, 0 errors; the repeat wrote 0 |
| Inactive pages | ended class shows "Registration closed", no Register; its course page no longer lists it; old empty class pages now show their details as closed |
| Scenarios: real sync vs real instance, Traction Rec simulated | 13 of 13 steps: new records + pages, zero-write repeat, field and price change, rename (slug kept), re-parent, registration closes, comes back, removed, lost parent, membership no longer sold, unused prices, steady state, cleanup |
| Unit tests | 42 pass |

## 5. Open items and risks

- **Publish the site code to the live domain**, then run the live-cache check
  (`npm run test:live-cache`). The live domain caches pages in Varnish, so a
  published dataset change must clear the pages that print it. This is
  untested until the code is live. The publish was blocked for the agent, so
  it needs a person.
- **Deploy the function** and point the calling service at it. Until it runs
  regularly, classes, prices and spot counts go stale, and a closed
  registration window stays open on the site.
- **Editors can edit dataset items in the Manager.** Zesty has no read-only
  field. An edit holds until that record next changes in Traction Rec.
- **Sandbox → production Traction Rec** changes every Salesforce Id. That needs
  a clean rebuild before launch.
- The old `/tractionrec/` views are still on the instance, unread; delete them
  when convenient.
- Nothing is committed yet.

**Further reading:**
- [dataset-storage.md](dataset-storage.md): the design, the instance
  measurements behind it, the full field list, and the browser-fetch option.
- The repo's `AGENTS.md`: the sync's rules, commands and tests in one page.
- The site's `AGENTS.md` §3 and §5: the template patterns.
