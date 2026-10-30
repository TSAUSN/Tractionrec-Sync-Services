# Storing Traction Rec in Zesty datasets

*Status (29 October 2026): **this is the sync.** The nine models exist, the sync (`src/datasets/`, §3) fills them and creates the catalog page items, and every catalog page and membership block reads them (§4). The first version, the file sync, is archived (`archive/file-sync/`). Not deployed yet.* The question:
could the sync store Traction Rec records as **Zesty dataset items** instead of
JSON files under `/tractionrec/`? Japheth's direction: nested arrays become
**child datasets**, and every reference is a **one-to-one relation**, not a
Traction Rec id. The one many-to-many link, program ↔ category, is a
`one_to_many`; there are no junction datasets.

**Answer: yes.** Every value fits a Zesty field type, and Parsley can join the
datasets server-side. This doc records what was measured, the model design,
how the dataset sync works, and what the site would have to change. The model
specs are in [`zesty-models/`](../zesty-models/).

Moving the site onto the datasets reverses two earlier decisions: Traction Rec
data stays out of Zesty fields (2026-09-30), and nested `__r` objects are not
flattened (2026-10-02).

## 1. What the probes showed

Tested 2026-10-19 on two throwaway datasets, with real records (a 2,131-character
course rich description and a class deep link). Everything was written through the
instance API and rendered on stage through `/test-page/`'s Parsley runner.

### Writing (instance API)

| Field type | Behaviour |
| --- | --- |
| `text` | **Max 150 characters.** 151 is rejected (`Data too long`); an accented character counts as one. |
| `textarea`, `wysiwyg_basic` | Max 65,535. Salesforce HTML is stored byte-for-byte in both. |
| `link` | 300 characters accepted. |
| `number` | `null` stays null and 0 stays 0; decimals are kept. **`""` or text fails with a 500**, so send `null`. |
| `currency` | Stored as a string (`"15.50"`). A number is accepted. |
| `yes_no` | `true` is stored as 1. **An omitted value is stored as 0, not null.** |
| `date` | An ISO value with a time is accepted and cut to the date. An invalid date fails with a 500. |
| `datetime` | `2025-02-20T22:12:35.000+0000` is accepted and stored as `2025-02-20 22:12:35`, so the offset is dropped. Salesforce returns UTC, so nothing is lost. |
| `one_to_one` | **Holds exactly one ZUID.** Two comma-joined ZUIDs are rejected. **The value is not validated:** a ZUID that doesn't exist, a ZUID from another model and a raw Traction Rec id were all accepted. |

The item payload is `POST content/models/<6-zuid>/items {data, web:{metaTitle}, meta:{listed:true}}`.
Unpublished items render on stage but show 0 items on the live domain, so every
write must be published.

### Reading (Parsley, native dataset loops)

| Pattern | Result |
| --- | --- |
| `where t.tractionrec_id = 'a1za…'` | works |
| `where FIND_IN_SET('a2za…', t.category_ids)` on a text CSV | works |
| `where n > 5`, `where n IS NULL`, `where yes_no = 1`, `where date >= '2026-10-01'` | all work |
| `sort by t.field desc`, `limit 2` | work. Unlike a fetched JSON loop, a native loop honours `where`, `sort` and `limit`. |
| **children:** `each tr_child as c where c.parent = '{p.zuid}'`, nested inside the parent loop | **works**: the outer alias interpolates |
| **parent:** `each tr_parent as p where p.zuid = '{c.parent}'` | works |
| dotted read through a relation: `{{c.parent.name}}`, `{{p.page.getUrl()}}` | **does not traverse.** It prints the ZUID, or nothing for `getUrl()`. It doesn't crash. |
| a related page's URL: `each courses as cp where cp.zuid = '{t.page}'` → `{{cp.getUrl()}}` | works, and follows URL renames |
| a null number prints as | empty (0 prints `0`) |
| `toJson()` | **resolves relations by itself, 2 levels deep** (then `"max hydration depth hit"`). `yes_no` comes back as `"1"`. |
| `/-/gql/<model>.json` | works for datasets; a relation is a bare ZUID; 119 items came back unpaged |
| `/-/instant/<6-zuid>.json` | **works for datasets** and carries item ZUIDs. Only the `/-/instant/` index leaves datasets out. |

### Render cost (stage, which doesn't cache)

| Render | Time |
| --- | --- |
| A catalog page today (file include) | 0.85–1.1 s |
| Plain loop over 119 courses | ~1 s |
| 119 courses printing 5 fields including `getUrl()` | 3.5 s |
| 118 courses × one nested child query each | 2.2 s |
| `toJson()` on 66 classes | 8.5 s |
| `toJson()` on 118 courses, relations resolved | **15.3 s**, 378 KB |

**Rule: never call `toJson()` across a dataset that has relations.** Print the
fields you need. One record plus its children (a detail page) is cheap.

## 2. The model tree

```
tr_program_categories ◀══ tr_programs ◀── tr_courses ◀── tr_classes
        │ page          (one_to_many) │ page       │ page         │ page, product
        ▼                             ▼            ▼              ▼
   categories (page)             programs      courses        classes             tr_products
                                                                                                        ▲   ▲
tr_membership_categories ◀── tr_membership_types ── product ───────────────────────────────────────────┘   │
                                                                     tr_billing_schedules ──▶ tr_price_levels ── product
```

Arrows point from the item that holds the relation field to the item it names. ══ is the one `one_to_many`; every other arrow is `one_to_one`.

| Model | Traction Rec object | Items today | Relations |
| --- | --- | --- | --- |
| `tr_program_categories` | `TREX1__Program_Category__c` | 9 | `page` → categories |
| `tr_programs` | `TREX1__Program__c` | 20 | `page` → programs, `program_categories` (one_to_many) |
| `tr_courses` | `TREX1__Course__c` | 118 | `page` → courses, `program` |
| `tr_classes` | `TREX1__Course_Session_Option__c` | 64 | `page` → classes, `course`, `product` |
| `tr_products` | `TREX1__Product__c` | 51 | — |
| `tr_price_levels` | `TREX1__Price_Level__c` | 74 | `product` |
| `tr_billing_schedules` | `TREX1__Planned_Billing_Schedule__c` | 20 | `price_level` |
| `tr_membership_categories` | `TREX1__Membership_Category__c` | 7 | — |
| `tr_membership_types` | `TREX1__Membership_Type__c` | 24 | `category`, `product` |

About **387 items**, on the same publishing gates the files use today.

### Why this shape

- **One record → one item.** Each item keeps its own Salesforce Id in a
  `tractionrec_id` text field, because that's how the sync finds the item to
  update. **References to other records are one_to_one fields** holding the
  other item's ZUID; there are no parent Traction Rec ids.
- **Price levels hang off Products, not off classes.** The 64 classes share **50
  distinct** levels through 27 Products, so a level linked to a class would be
  duplicated. Classes and membership types each point at their Product, and
  levels and schedules hang beneath it, the way Traction Rec has it. Membership
  levels aren't shared, but they use the same path.
- **Arrays become child datasets.** `prices[]` becomes `tr_price_levels`, and
  `prices[].schedules[]` becomes `tr_billing_schedules`.
- **1:1 lookups are flattened onto the record**, not given their own dataset.
  Course Option is 1:1 with its class (64 options across 64 classes), so its dates,
  days, times, ages, capacity and instructor become class fields. Of the Course
  Session, a class needs only the name, the season and the course, so the first
  two are flattened and the course is a relation. Membership type's
  `Product__r.Price_Description__c` moves to `tr_products`.
- **Many-to-many is the one `one_to_many`** (Japheth 2026-10-19: no junction
  dataset). Traction Rec links programs to categories through the
  `TREX1__Program_Category_Tag__c` junction, and a one_to_one holds a single
  ZUID, so `tr_programs.program_categories` holds the categories' ZUIDs as a
  CSV. No program has two categories today, but Traction Rec allows it. A
  category's programs: `each tr_programs as p where FIND_IN_SET('{c.zuid}',
  p.program_categories)`. Verified on the real models with temporary items: a
  program in two categories is listed under both.
- **Links to the Zesty pages:** the four catalog datasets carry `page`
  (one_to_one → the page item). This gives links that follow URL renames
  (`each courses as cp where cp.zuid = '{t.page}'` → `getUrl()`) and replaces
  `meta.zestyPath`. Memberships have no pages.

### Field conventions

- **Names are readable snake_case** (`start_date`, `capacity_available`), because
  Salesforce API paths don't fit as Zesty field names. **Each field's description
  holds its exact Traction Rec source** (`TREX1__Course_Option__r.TREX1__Start_Date__c`),
  so the Manager shows where a value comes from. Descriptions stay under 240
  characters, because a longer description fails the field write with a 500.
- **Types:**
  - Ids, names and short values: `text`. Anything over 150 characters: `textarea`.
  - Rich-text HTML: `textarea`, not WYSIWYG, so that a Manager editor can't
    reformat what the sync owns.
  - Times (`19:00:00.000`), multipicklists (`Monday;Wednesday`) and picklists:
    `text`, kept verbatim. A `dropdown` would reject the next new Traction Rec
    value.
  - Money: `currency`. Counts and ages: `number`, where null means "no limit".
  - Checkboxes: `yes_no`. Salesforce datetimes: `datetime`, in UTC.
- **Every dataset ends with** `last_modified_date`, `system_modstamp`,
  `sync_hash` and `synced_at`. The hash on the item replaces the ledger entry for
  that record.
- `TREX1__Course_Online_Availability__c` is dropped: it's the class gate, so
  it's always null on a synced row.

## 3. The sync

Built 2026-10-19 in `src/datasets/`. Since 2026-10-29 it is **the** sync:
- the file sync is archived;
- `src/index.js` (the HTTP function) and `src/cli.js` run this one;
- it also creates the catalog page items.

The repo's `AGENTS.md` §2–3 has the full rules. In short:

- **It re-reads the whole published set on every run, never incrementally.**
  The class gate (`TREX1__Course_Online_Availability__c`) is a time-based
  formula: a class leaves the set when its registration window closes, and
  enters it when one opens, without the record being modified (verified
  2026-10-29).
- **It plans each row and writes only what changed.** Plans are pure
  (`plan.js`). `sync_hash` covers every written field, relations and
  `active` included, so a quiet run writes nothing.
- **Lifecycle: nothing is deleted.** Every dataset has `active` and
  `inactive_reason`. A known record that is no longer published becomes
  `active = 0` with a reason:
  - **re-read without the gate:** Traction Rec's own reason, e.g. "Outside
    Course Option Registration Timeframe";
  - **missing from Traction Rec:** "Removed from Traction Rec", keeping its
    last data;
  - **a published record whose required parent can't be resolved:** "No
    program_categories in Traction Rec" / "Its course (…) is not in
    tr_courses", keeping its old relation;
  - **a product / price level / schedule no longer used:** "No longer used by
    a published class or membership type".

  It flips back to `active = 1` when Traction Rec publishes it again.
  "Known" includes the catalog page items: the 20 old class pages that never
  had a row got an inactive one on 2026-10-29.
- **Page items** (`pages.js`):
  - **Created** for published records whose parent has a page, at the
    **root** (no `parentZUID`, like the 300+ existing pages). They hold only
    `tractionrec_id`, the title, the slug, `metaTitle` and `metaLinkText`.
  - **On a rename**, the title field, `metaTitle` and `metaLinkText` follow.
    **The slug never changes.**
  - The page models' editorial fields were made optional so no placeholders
    are needed.
- **Relations are checked by the sync,** since Zesty validates none.

**Verified 2026-10-29:**
- **First run with the lifecycle:** every item gained the new fields, with 0
  errors and 297 s. It made 24 classes, 2 programs, 4 products and 6 price
  levels inactive.
- **The run after it:** 0 writes, 16 s.
- **Scenarios:** 13 out of 13 steps passed, the real sync against the real
  instance with Traction Rec simulated (AGENTS.md §6).

**Not done:**
- Deploying it.
- Publishing the site code to the live domain and running the live-cache
  check.

## 4. How the site reads it (built 2026-10-20)

All the Traction Rec readers on the site moved to the datasets on 2026-10-20:
the five catalog page views (`categories_page`, `categories`, `programs`,
`courses`, `classes`) and the two membership blocks (`[membership_tiers]`,
`[day_pass_passes]`). **No page fetches anything.** Each view loops the
datasets in Parsley and prints the rows it needs into its page script. Nothing reads the `/tractionrec/` files any more. Details are in the site's
`AGENTS.md` §3 and §5.

**Row snippets.** `views/datasets/{class,course,program,category,membership-type}.json`
each print one row as strict JSON (Parsley inside a `.json` view, valid as JSON
and as JavaScript): Zesty field names, every value a
string, relations as ZUIDs, `url` from the row's `page` relation via
`classes.filter(z.zuid = '{cls.page}').getUrl()` (a single value is read with
`filter()`, not a loop), and class prices and membership levels/schedules nested. A view
includes a snippet inside a loop with the snippet's alias (`cls`, `crs`,
`prg`, `cat`, `mt`); an included view sees the caller's alias. Text goes
through `escapeForJs()`, which round-trips Traction Rec copy exactly.

A class page, trimmed:

```
self: "{{tr_classes.filter(page = '{this.zuid}').zuid}}",
classes: [ {{each tr_classes as me where me.page = '{this.zuid}'}}
             {{each tr_classes as cls where cls.course = '{me.course}'}}{{ include /datasets/class.json }},{{end-each}}
           {{end-each}} ],
courses / programs / categories: the same, one parent per level
```

`krocDs()` (`catalogdata.jsx`) de-duplicates and indexes the rows by ZUID.
The `krocDs*ToCard` adapters produce the same card props the file-based
adapters did, so the cards, listings and layout are unchanged. Text captures
of every catalog page and both blocks, on desktop and mobile, matched the
file-based pages except where Traction Rec's data had changed since the last
file sync (classes that have ended).

**Membership blocks** still match repeater rows to types by `tractionrec_id`.
A repeater can't hold a relation, so the row keeps the Traction Rec Id, and
`krocTrMembershipIndex` keys the printed types by it.

**Render cost (stage, uncached):**
- **A detail page:** about 1 s.
- **`/categories-page/`:** about 3 s. It prints the whole catalog for the class
  finder (45 classes with prices and page URLs, plus 118 courses, 20 programs
  and 9 categories, about 43 KB), and most of the time is the 66 page
  `getUrl()` lookups. The live domain caches the page.

Japheth accepted the 3 s for now (2026-10-20).

### If the class finder moves to a browser fetch

If the root page gets too slow (more classes, or caching that doesn't help),
only the finder needs to change. The category grid is small and can stay
server-side. The options, as measured on 2026-10-19 and 10-20:

| Source | Works for the finder? | Catch |
| --- | --- | --- |
| `/-/instant/<6-zuid>.json` | yes: rows carry `meta.zuid`, and relations come back as `{data:[{zuid}]}` | the URL needs the **model ZUID**, which differs on every Kroc instance; emit it from Parsley (e.g. a `toJson()` of one row carries `meta.model.zuid`) rather than hardcoding it. Responses carry a lot of metadata |
| `/-/gql/<model>.json` | no, not alone: rows have no ZUID, so relations (ZUIDs) can't be joined | addressed by model name, so portable |
| a custom JSON view (e.g. `/datasets/finder.json`) printing the same rows | yes: reuse the snippets, `fetch()` it | a new endpoint, which needs Japheth's OK (rule of 2026-10-05); it costs the same render time, but out of the page's critical path |
| the `/tractionrec/` tier files | no longer | the file sync that wrote them is archived (2026-10-29) |

Whichever is used, `krocFinderFeed(ds)` (`classfinder.jsx`) takes a `krocDs`
bundle, so the fetch only has to rebuild that bundle.

## 5. Open decisions

- **Migration: done.** Every site reader moved to the datasets on 2026-10-20,
  and the file sync was archived on 2026-10-29. Its `/tractionrec/` views are
  still on the instance, unread. The page-model mirror fields (copied Traction
  Rec values) are no longer written; removing them from the models is a later
  clean-up.
- **Editors can still type into these fields.** Zesty has no read-only field.
  The model and field descriptions say the sync owns them, and the sync
  overwrites on the next change, but not before.

The probe models ("ZZ Probe TR Parent/Child (delete me)") were deleted on
2026-10-19 with `zesty-model.mjs delete`.

## Creating the models

**Created 2026-10-19.** Each was dry-run first, and `show` matches its spec field
for field:

| Model | ZUID |
| --- | --- |
| `tr_program_categories` | `6-acf1f0aba7-9x0t1s` |
| `tr_programs` | `6-e6d2c1bcf4-jr61j5` |
| `tr_courses` | `6-a88bf2c8d1-1m6sdb` |
| `tr_products` | `6-acebda8eb1-0z81w1` |
| `tr_price_levels` | `6-a8d1e4af8c-lt3pp4` |
| `tr_billing_schedules` | `6-f0b38ca7f0-fcrtbl` |
| `tr_classes` | `6-928cfff8dc-3g49jh` |
| `tr_membership_categories` | `6-e0c895ba8e-5n0bmp` |
| `tr_membership_types` | `6-eaeffba3e0-lwv250` |

**Models are created once, by hand, with the zesty skill's `zesty-model.mjs`.
The sync service does not create them.** The split matches what the sync
already does with the catalog page models, which exist before it runs:

- **The schema is a reviewed, one-off change.** Specs are dry-run and read before
  anything is created. A sync that creates models would change the schema
  unattended, and a bug in it would write fields nobody reviewed.
- **The service's token stays narrower.** It writes and publishes items. It
  doesn't need to create or change models.
- **The sync checks the schema instead.** At the start of a run it should
  confirm that every `tr_*` model and field it writes exists with the expected
  type, and stop with a clear error if one doesn't. `requiredFieldsFor` already
  reads model fields this way.
- **Changing a model later** (a new Traction Rec field) is a spec edit plus
  `zesty-model.mjs add-fields`, then the sync mapping.

The specs are numbered in creation order, because a relation needs its target
to exist. From the site repo:

```
for f in ../kroc-tractionrec-sync/zesty-models/*.json; do
  node .claude/skills/zesty/scripts/zesty-model.mjs create "$f" --dry-run
done
```

Drop `--dry-run` to create. A dry run of a spec whose relation target isn't
created yet fails with "related model not found". That's expected; dry-run
01, 04 and 08 alone.

## Appendix: fields

Generated from [`zesty-models/`](../zesty-models/). The four sync fields that
end every model (`last_modified_date`, `system_modstamp`, `sync_hash`,
`synced_at`) are left out. `tractionrec_id` and `name` are required. `active`
and `inactive_reason` were added to every model on 2026-10-29 (§3).


**`tr_program_categories`** (12 fields)

| Field | Type | Traction Rec source |
| --- | --- | --- |
| `tractionrec_id` | text | TREX1__Program_Category__c.Id. The sync finds this item by it. |
| `name` | text | TREX1__Program_Category__c.Name |
| `page` | one_to_one → `categories` | The Zesty Categories page for this record (written by the sync). |
| `available` | yes_no | TREX1__Program_Category__c.TREX1__Available__c |
| `available_online` | yes_no | TREX1__Program_Category__c.TREX1__Available_Online__c |
| `description_rich_text` | textarea | TREX1__Program_Category__c.TREX1__Description_Rich_Text__c (HTML, kept verbatim) |
| `active` | yes_no | 1 = published online in Traction Rec now. 0 = no longer published (removed, outside its registration window, set Not Available, or its parent is gone); the site hides it. Set by the sync. |
| `inactive_reason` | textarea | Why active is 0: Traction Rec's own reason (e.g. Outside Course Option Registration Timeframe), Removed from Traction Rec, or a missing parent. Empty when active. |

**`tr_programs`** (13 fields)

| Field | Type | Traction Rec source |
| --- | --- | --- |
| `tractionrec_id` | text | TREX1__Program__c.Id. The sync finds this item by it. |
| `name` | text | TREX1__Program__c.Name |
| `page` | one_to_one → `programs` | The Zesty Programs page for this record (written by the sync). |
| `program_categories` | one_to_many → `tr_program_categories` | TREX1__Program_Category_Tag__c rows for this program (junction, many-to-many): their TREX1__Program_Category__c |
| `available` | yes_no | TREX1__Program__c.TREX1__Available__c |
| `available_online` | yes_no | TREX1__Program__c.TREX1__Available_Online__c |
| `description` | textarea | TREX1__Program__c.TREX1__Description__c |
| `active` | yes_no | 1 = published online in Traction Rec now. 0 = no longer published (removed, outside its registration window, set Not Available, or its parent is gone); the site hides it. Set by the sync. |
| `inactive_reason` | textarea | Why active is 0: Traction Rec's own reason (e.g. Outside Course Option Registration Timeframe), Removed from Traction Rec, or a missing parent. Empty when active. |

**`tr_courses`** (14 fields)

| Field | Type | Traction Rec source |
| --- | --- | --- |
| `tractionrec_id` | text | TREX1__Course__c.Id. The sync finds this item by it. |
| `name` | text | TREX1__Course__c.Name |
| `page` | one_to_one → `courses` | The Zesty Courses page for this record (written by the sync). |
| `program` | one_to_one → `tr_programs` | TREX1__Course__c.TREX1__Program__c |
| `available` | yes_no | TREX1__Course__c.TREX1__Available__c |
| `available_online` | yes_no | TREX1__Course__c.TREX1__Available_Online__c |
| `description` | textarea | TREX1__Course__c.TREX1__Description__c |
| `rich_description` | textarea | TREX1__Course__c.TREX1__Rich_Description__c (HTML, kept verbatim) |
| `active` | yes_no | 1 = published online in Traction Rec now. 0 = no longer published (removed, outside its registration window, set Not Available, or its parent is gone); the site hides it. Set by the sync. |
| `inactive_reason` | textarea | Why active is 0: Traction Rec's own reason (e.g. Outside Course Option Registration Timeframe), Removed from Traction Rec, or a missing parent. Empty when active. |

**`tr_products`** (9 fields)

| Field | Type | Traction Rec source |
| --- | --- | --- |
| `tractionrec_id` | text | TREX1__Product__c.Id. The sync finds this item by it. |
| `name` | text | TREX1__Product__c.Name |
| `price_description` | text | TREX1__Product__c.TREX1__Price_Description__c, e.g. "$15.00" |
| `active` | yes_no | 1 = published online in Traction Rec now. 0 = no longer published (removed, outside its registration window, set Not Available, or its parent is gone); the site hides it. Set by the sync. |
| `inactive_reason` | textarea | Why active is 0: Traction Rec's own reason (e.g. Outside Course Option Registration Timeframe), Removed from Traction Rec, or a missing parent. Empty when active. |

**`tr_price_levels`** (12 fields)

| Field | Type | Traction Rec source |
| --- | --- | --- |
| `tractionrec_id` | text | TREX1__Price_Level__c.Id. The sync finds this item by it. |
| `name` | text | TREX1__Price_Level__c.Name |
| `product` | one_to_one → `tr_products` | TREX1__Price_Level__c.TREX1__Product__c |
| `price_type` | text | TREX1__Price_Level__c.TREX1__Price_Type__c (Member / Non-Member; empty on memberships) |
| `amount` | currency | TREX1__Price_Level__c.TREX1__Total_Billing_Schedule_Amount__c |
| `initial_fee` | currency | TREX1__Price_Level__c.TREX1__Initial_Fee_Amount__c (memberships: registration fee; Day Pass: the price) |
| `active` | yes_no | 1 = published online in Traction Rec now. 0 = no longer published (removed, outside its registration window, set Not Available, or its parent is gone); the site hides it. Set by the sync. |
| `inactive_reason` | textarea | Why active is 0: Traction Rec's own reason (e.g. Outside Course Option Registration Timeframe), Removed from Traction Rec, or a missing parent. Empty when active. |

**`tr_billing_schedules`** (13 fields)

| Field | Type | Traction Rec source |
| --- | --- | --- |
| `tractionrec_id` | text | TREX1__Planned_Billing_Schedule__c.Id. The sync finds this item by it. |
| `name` | text | TREX1__Planned_Billing_Schedule__c.Name |
| `price_level` | one_to_one → `tr_price_levels` | TREX1__Planned_Billing_Schedule__c.TREX1__Price_Level__c |
| `term_type` | text | TREX1__Planned_Billing_Schedule__c.TREX1__Term_Type__c (Monthly / One Time / ...) |
| `amount` | currency | TREX1__Planned_Billing_Schedule__c.TREX1__Amount__c (per term) |
| `total_amount` | currency | TREX1__Planned_Billing_Schedule__c.TREX1__Total_Billing_Amount__c |
| `number_of_terms` | number | TREX1__Planned_Billing_Schedule__c.TREX1__Number_Of_Terms__c |
| `active` | yes_no | 1 = published online in Traction Rec now. 0 = no longer published (removed, outside its registration window, set Not Available, or its parent is gone); the site hides it. Set by the sync. |
| `inactive_reason` | textarea | Why active is 0: Traction Rec's own reason (e.g. Outside Course Option Registration Timeframe), Removed from Traction Rec, or a missing parent. Empty when active. |

**`tr_classes`** (34 fields)

| Field | Type | Traction Rec source |
| --- | --- | --- |
| `tractionrec_id` | text | TREX1__Course_Session_Option__c.Id. The sync finds this item by it. |
| `name` | text | TREX1__Course_Session_Option__c.Name |
| `page` | one_to_one → `classes` | The Zesty Classes page for this record (written by the sync). |
| `course` | one_to_one → `tr_courses` | TREX1__cso_Course_Session__r.TREX1__Course__c |
| `product` | one_to_one → `tr_products` | TREX1__Course_Option__r.TREX1__Product__c |
| `deep_link_url` | link | TREX1__Course_Session_Option__c.Deep_Link_URL__c (org formula) |
| `available_online` | yes_no | TREX1__Course_Session_Option__c.TREX1__Available_Online__c |
| `option_available` | yes_no | TREX1__Course_Session_Option__c.TREX1__Option_Available__c |
| `course_session_id` | text | TREX1__Course_Session_Option__c.TREX1__cso_Course_Session__c |
| `course_session_name` | text | TREX1__cso_Course_Session__r.Name |
| `season` | text | TREX1__cso_Course_Session__r.TREX1__Session__r.Name, e.g. "Fall 2026" |
| `course_option_id` | text | TREX1__Course_Session_Option__c.TREX1__Course_Option__c |
| `start_date` | date | TREX1__Course_Option__r.TREX1__Start_Date__c |
| `end_date` | date | TREX1__Course_Option__r.TREX1__End_Date__c |
| `day_of_week` | text | TREX1__Course_Option__r.TREX1__Day_of_Week__c (multipicklist, kept as "Monday;Wednesday") |
| `start_time` | text | TREX1__Course_Option__r.TREX1__Start_Time_Formula__c ("19:00:00.000") |
| `end_time` | text | TREX1__Course_Option__r.TREX1__End_Time_Formula__c ("20:00:00.000") |
| `age_min` | number | TREX1__Course_Option__r.TREX1__Age_Min__c |
| `age_max` | number | TREX1__Course_Option__r.TREX1__Age_Max__c (empty = no upper limit) |
| `instructor` | text | TREX1__Course_Option__r.TREX1__Instructor__c (free text) |
| `capacity` | number | TREX1__Course_Option__r.TREX1__Capacity__c |
| `registration_total` | number | TREX1__Course_Option__r.TREX1__Registration_Total__c |
| `capacity_available` | number | TREX1__Course_Option__r.TREX1__Total_Capacity_Available__c |
| `unlimited_capacity` | yes_no | TREX1__Course_Option__r.TREX1__Unlimited_Capacity__c |
| `show_capacity_online` | yes_no | TREX1__Course_Option__r.TREX1__Show_Capacity_Online__c |
| `waitlist_total` | number | TREX1__Course_Option__r.TREX1__Waitlist_Total__c |
| `waitlist_capacity` | number | TREX1__Course_Option__r.TREX1__Waitlist_Capacity__c |
| `description` | textarea | TREX1__Course_Option__r.TREX1__Description__c |
| `active` | yes_no | 1 = published online in Traction Rec now. 0 = no longer published (removed, outside its registration window, set Not Available, or its parent is gone); the site hides it. Set by the sync. |
| `inactive_reason` | textarea | Why active is 0: Traction Rec's own reason (e.g. Outside Course Option Registration Timeframe), Removed from Traction Rec, or a missing parent. Empty when active. |

**`tr_membership_categories`** (12 fields)

| Field | Type | Traction Rec source |
| --- | --- | --- |
| `tractionrec_id` | text | TREX1__Membership_Category__c.Id. The sync finds this item by it. |
| `name` | text | TREX1__Membership_Category__c.Name |
| `available_online` | yes_no | TREX1__Membership_Category__c.TREX1__Available_Online__c |
| `available_for_purchase` | yes_no | TREX1__Membership_Category__c.TREX1__Available_For_Purchase__c |
| `category_description` | textarea | TREX1__Membership_Category__c.TREX1__Category_Description__c |
| `display_order` | number | TREX1__Membership_Category__c.TREX1__Display_Order__c |
| `active` | yes_no | 1 = published online in Traction Rec now. 0 = no longer published (removed, outside its registration window, set Not Available, or its parent is gone); the site hides it. Set by the sync. |
| `inactive_reason` | textarea | Why active is 0: Traction Rec's own reason (e.g. Outside Course Option Registration Timeframe), Removed from Traction Rec, or a missing parent. Empty when active. |

**`tr_membership_types`** (37 fields)

| Field | Type | Traction Rec source |
| --- | --- | --- |
| `tractionrec_id` | text | TREX1__Membership_Type__c.Id. The sync finds this item by it. |
| `name` | text | TREX1__Membership_Type__c.Name |
| `category` | one_to_one → `tr_membership_categories` | TREX1__Membership_Type__c.TREX1__Category__c |
| `product` | one_to_one → `tr_products` | TREX1__Membership_Type__c.TREX1__Product__c |
| `available_online` | yes_no | TREX1__Membership_Type__c.TREX1__Available_Online__c |
| `available_for_purchase` | yes_no | TREX1__Membership_Type__c.TREX1__Available_For_Purchase__c |
| `description` | textarea | TREX1__Membership_Type__c.TREX1__Description__c |
| `age_range_name` | text | TREX1__Membership_Type__c.TREX1__Age_Range_Name__c |
| `min_age` | number | TREX1__Membership_Type__c.TREX1__Min_Age__c |
| `max_age` | number | TREX1__Membership_Type__c.TREX1__Max_Age__c (110 = no upper limit) |
| `term_length` | number | TREX1__Membership_Type__c.TREX1__Term_Length__c |
| `term_type` | text | TREX1__Membership_Type__c.TREX1__Term_Type__c (Daily / Monthly / ...) |
| `end_date_setting` | text | TREX1__Membership_Type__c.TREX1__End_Date_Setting__c |
| `fixed_term_start_date` | date | TREX1__Membership_Type__c.TREX1__Fixed_Term_Start_Date__c |
| `fixed_term_end_date` | date | TREX1__Membership_Type__c.TREX1__Fixed_Term_End_Date__c |
| `is_group` | yes_no | TREX1__Membership_Type__c.TREX1__Is_Group__c |
| `group_1_name` | text | TREX1__Membership_Type__c.TREX1__Group_1_Name__c |
| `group_1_plural_name` | text | TREX1__Membership_Type__c.TREX1__Group_1_Plural_Name__c |
| `group_1_min_age` | number | TREX1__Membership_Type__c.TREX1__Group_1_Min_Age__c |
| `group_1_max_age` | number | TREX1__Membership_Type__c.TREX1__Group_1_Max_Age__c |
| `group_1_max_allowed` | number | TREX1__Membership_Type__c.TREX1__Group_1_Max_Allowed__c |
| `group_2_name` | text | TREX1__Membership_Type__c.TREX1__Group_2_Name__c |
| `group_2_plural_name` | text | TREX1__Membership_Type__c.TREX1__Group_2_Plural_Name__c |
| `group_2_min_age` | number | TREX1__Membership_Type__c.TREX1__Group_2_Min_Age__c |
| `group_2_max_age` | number | TREX1__Membership_Type__c.TREX1__Group_2_Max_Age__c |
| `group_2_max_allowed` | number | TREX1__Membership_Type__c.TREX1__Group_2_Max_Allowed__c |
| `group_3_name` | text | TREX1__Membership_Type__c.TREX1__Group_3_Name__c |
| `group_3_plural_name` | text | TREX1__Membership_Type__c.TREX1__Group_3_Plural_Name__c |
| `group_3_min_age` | number | TREX1__Membership_Type__c.TREX1__Group_3_Min_Age__c |
| `group_3_max_age` | number | TREX1__Membership_Type__c.TREX1__Group_3_Max_Age__c |
| `group_3_max_allowed` | number | TREX1__Membership_Type__c.TREX1__Group_3_Max_Allowed__c |
| `active` | yes_no | 1 = published online in Traction Rec now. 0 = no longer published (removed, outside its registration window, set Not Available, or its parent is gone); the site hides it. Set by the sync. |
| `inactive_reason` | textarea | Why active is 0: Traction Rec's own reason (e.g. Outside Course Option Registration Timeframe), Removed from Traction Rec, or a missing parent. Empty when active. |
