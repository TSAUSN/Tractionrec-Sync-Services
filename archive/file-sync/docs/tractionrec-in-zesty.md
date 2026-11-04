# Traction Rec in Zesty — end to end

How Traction Rec data gets into the
Zesty instance and how the site reads it, tier by tier, with how memberships
differ from the class catalog. Brief on purpose: it links to the detailed docs
instead of repeating them.

> **The site now reads the `tr_*` datasets, not these files.** A
> second, separate dataset sync (`src/datasets/`) fills nine Zesty datasets, and
> every catalog page and both membership blocks loop them in Parsley; nothing is
> fetched. The file sync described here still runs, and only `/test-page/` reads
> its files. See [dataset-sync.md](dataset-sync.md) and [dataset-storage.md](dataset-storage.md) §4. The tables below
> on how pages read files are kept as the history of that design.

## 1. The pipeline

```
Traction Rec (Salesforce, TREX1__*)
   │  SOQL, OAuth client credentials — secret stays in the service
   ▼
kroc-tractionrec-sync (Cloud Function)
   ├─▶ JSON views under /tractionrec/ on the instance   (every tier)
   └─▶ one Zesty content item per record                 (catalog tiers only)
   ▼
Zesty WebEngine
   ├─ catalog page views  {{ include }} their own row + children
   └─ membership blocks   {{ include }} membership_types.json
   ▼
Components (Kroc-Center-Template/webengine/views/components)
```

Traction Rec is the system of record. The sync is one-way and writes only
when a hash changes, so a quiet run writes nothing.

## 2. Tiers

| Tier key | Traction Rec object | Parent | Gate (what syncs) | Zesty model | Items |
| --- | --- | --- | --- | --- | --- |
| `program_categories` | `TREX1__Program_Category__c` | — | all | `categories` | yes |
| `programs` | `TREX1__Program__c` | category, via junction `Program_Category_Tag__c` (many-to-many) | all | `programs` | yes |
| `courses` | `TREX1__Course__c` | `TREX1__Program__c` | all | `courses` | yes |
| `classes` | `TREX1__Course_Session_Option__c` | `cso_Course_Session__r.TREX1__Course__c` | `Course_Online_Availability__c = null` | `classes` | yes |
| `membership_categories` | `TREX1__Membership_Category__c` | — | online **and** for purchase | none | **no** |
| `membership_types` | `TREX1__Membership_Type__c` | `TREX1__Category__c` | type **and** its category online + for purchase | none | **no** |

## 3. What the sync writes

```
/tractionrec/<tier>.json                         every row of the tier
/tractionrec/<tier>/<id>.json                    one row
/tractionrec/<parentTier>/<id>/<childTier>.json  that parent's children ([] if none)
/tractionrec/_sync-state.json                    hash ledger
```

Each row is the Salesforce record **verbatim at the root** (Parsley reads one
level deep) plus `meta`. The sync adds only:

- `TREX1__Program_Category__c` on programs: category ids from the junction.
- `prices` on classes and membership types: Price Level rows
  `{ id, name, priceType, amount, initialFee }`. On membership types each
  level also has `schedules` (Planned Billing Schedules).
- `meta.zestyItemZuid` / `meta.zestyPath` on catalog rows: the record's Zesty
  page. Membership rows have neither.


## 4. Catalog: Traction Rec record ↔ Zesty page

**Items.** On first sight of a record the sync creates its Zesty item (one
page per category, program, course, class) with `tractionrec_id` = the
Salesforce Id, a unique path part, and a seeded parent link. It never updates
or deletes an item afterwards; a record that leaves Traction Rec is reported,
not removed. URL, SEO, layout and editorial fields belong to Zesty.

**How each page read its data before the datasets** (inlined at render time; now
replaced by dataset loops, [dataset-storage.md](dataset-storage.md) §4):

| Page view | Includes | Fetched client-side |
| --- | --- | --- |
| `categories_page` | `program_categories.json` | `classes`, `courses`, `programs`, `program_categories` `.json` (class finder) |
| `categories` | `program_categories/<id>.json`, `…/<id>/programs.json` | — |
| `programs` | `programs/<id>.json`, `…/<id>/courses.json` | `classes.json` (class counts per course); crumbs: its category |
| `courses` | `courses/<id>.json`, `…/<id>/classes.json` | sibling courses `programs/<programId>/courses.json`; crumbs: program, category |
| `classes` | `classes/<id>.json` | sibling classes `courses/<courseId>/classes.json`; crumbs: course, program, category |

`<id>` is `{this.tractionrec_id}`. Parent ids sit inside the Traction Rec data,
which Parsley can't put in an include path, so crumbs fetch one record file per
level (`krocTrTrail`). A missing file includes as nothing.

**Who owns what.**

- Traction Rec: names, descriptions, dates, days, times, ages, instructors,
  prices, capacity and spots, parentage, the Register link
  (`Deep_Link_URL__c`).
- Zesty, from the page's own item only: hero image, icon, subtitle, intro
  copy, class type, location, tags.
- Every Zesty field that mirrors Traction Rec is ignored (the title is only a
  fallback when there is no row).
- Cards link with `meta.zestyPath`; crumbs come from Traction Rec parent ids.

## 5. Memberships: Traction Rec record ↔ block card

**No model, no items.** Nothing in the design gives a membership its own page.
Memberships appear as cards in two blocks, so the files are the whole output.

**The link is per card.** `[membership_tiers].tiers` and
`[day_pass_passes].passes` rows have a `tractionrec_id` sub-field (the
Membership Type Id, `a2g…`). The editor chooses which types show and in what
order. Autopay, Annual and 1 Month are separate types, and types have no
order in Traction Rec. Both block views include the whole
`membership_types.json` (about 58 KB) and index it by Id
(`krocTrMembershipIndex`, `components/membershipdata.jsx`).

**A linked row** takes price, period and ages from Traction Rec and ignores
the typed ones:

| Kind | Price | Period |
| --- | --- | --- |
| Autopay | schedule with `termType` "Monthly" → `amount` | "/mo" |
| Annual, 1 Month, seasonal | schedule "One Time" → `amount` | from `Term_Length__c` + `Term_Type__c`: "/yr", "/mo", " for 3 months" |
| Day Pass (no schedule) | level `initialFee` (the level total is $0) | — |

- On memberships with a schedule, the level's `initialFee` is the one-time
  registration fee. It fills the `{fee}` placeholder in
  `[membership_tiers].fine_print`.
- Family types show their household rules from `Group_1..3_*`.
- **Name:** Traction Rec's name without the payment plan or a trailing
  "Membership". A typed `tier_name` (or `audience`/`label`) overrides it.
  That's the one typed value that wins: it's wording, so it can't show a wrong
  price.
- **Fallbacks:** an id missing from the file (no longer sold online) hides the
  card. No file at all renders every row as typed.

**Purchase links.** Block link fields (`cta_link`, `primary_cta_url`,
`cta_url`) are never read. Traction Rec has no membership link (the class
`Deep_Link_URL__c` is an org formula with no membership counterpart). So all
purchase buttons use the interim `globals.membership_purchase_url` through
`krocTrMembershipPurchaseUrl`. That's the place to switch to a Traction Rec
field once the org adds one.

## 6. Side by side

| | Catalog | Memberships |
| --- | --- | --- |
| Zesty model / items | one per tier / one per record, created by the sync | none |
| Join key lives on | the page item (`tractionrec_id` field) | the block's repeater row |
| What appears | everything Traction Rec publishes online | what the editor links |
| Page reads | its own row + children files | the whole tier file |
| Link out | `Deep_Link_URL__c` (Traction Rec) | Globals link, until Traction Rec has one |
| Price | level `amount` (member / non-member) | schedule or level `initialFee`, by kind |
| Zesty still owns | hero, icon, intro, type, location, tags | headings, fine-print wording, name override, order |

The same data stored as Zesty datasets instead of files (a separate dataset sync fills them; the site doesn't read them yet) is covered in [dataset-storage.md](dataset-storage.md).
