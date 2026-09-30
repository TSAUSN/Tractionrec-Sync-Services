# Data mapping

> Which Traction Rec object becomes which Zesty model, what lands in a
> snapshot, and what the front end does with it. The authoritative field
> reference is `KROC-draft/tractionrec-sandbox-content-model.md`; this document
> only covers what the sync touches.

---

## The four tiers

| Tier key | Traction Rec object | Records | Zesty model | Snapshot path |
| :--- | :--- | ---: | :--- | :--- |
| `program_category` | `TREX1__Program_Category__c` | 9 | `categories` | `/tractionrec/program_category/<id>.json` |
| `program` | `TREX1__Program__c` | 22 | `programs` | `/tractionrec/program/<id>.json` |
| `course` | `TREX1__Course__c` | 119 | `courses` | `/tractionrec/course/<id>.json` |
| `class` | `TREX1__Course_Session_Option__c` | 933 → ~96 publishable | `classes` | `/tractionrec/class/<id>.json` |

**The leaf is the junction, not Course Option.** `TREX1__Course_Session_Option__c`
is what carries the publishing gate and the registration deep link, and a
Course Option can appear under more than one Course Session. Syncing Course
Option directly would lose both.

This also settles an open point from the integration spec, which had
`[classes]` carrying **two** Traction Rec ids (Course Session + Course Option)
because the deep link needs both. It does not need two: the junction row has
its own Id, and `Deep_Link_URL__c` is a formula *on the junction* that already
contains both. One `tractionrec_id` is enough at every tier.

The class tier is the only one with a `WHERE` clause:

```sql
WHERE TREX1__Course_Online_Availability__c = null
```

That formula returns pipe-delimited *blocking reasons* and blank means
publishable, so Traction Rec computes the entire visibility gauntlet — nine
rules — in its own database. The site does not reimplement any of it. It is
filterable, so the gate runs server-side; 96 of 933 rows clear it at the time
of writing, which varies with the season.

---

## The `tractionrec_id` field

Verified on the live instance (`8-80c0bba6b8-lhkcc7`) 2026-09-25:

| Model | ZUID | `tractionrec_id` |
| :--- | :--- | :--- |
| `categories` | `6-a4a2bccd9b-dft9k5` | ✅ present |
| `programs` | `6-a4f493b68d-v9xm4d` | ❌ **missing** |
| `courses` | `6-f2e1e683e1-p7g6v1` | ❌ **missing** |
| `classes` | `6-e8cde1aef0-xpwj5x` | ❌ **missing** |

Note there is also an older `program_categories` pageset
(`6-a0ca8ee7f3-hb7kz3`). The catalog endpoints use `categories`, and so does
this service. Add the field to the three that lack it:

| Property | Value |
| :--- | :--- |
| Label | Traction Rec ID |
| Reference ID | `tractionrec_id` |
| Type | Single Line Text |
| Required | No |

Notes:

- It holds an 18-character Salesforce Id (`a0X1U000001abcUAA`). Case matters:
  Salesforce also issues a 15-character case-sensitive form, and the API
  returns the 18-character one. The service stores whatever the API returned
  and compares exactly — don't hand-type these.
- Editors should not change it. It is the join key; a typo detaches the item
  from its data and the next run creates a duplicate alongside it. Put it at
  the bottom of the field list, or mark it admin-only if the instance allows.
- Two items carrying the same value is a conflict and the service refuses to
  write either. Usually the cause is a duplicated item in the Manager.

---

## What the service writes on a Zesty item

The models' own field names are verified too, and match what `src/config.js`
expects: `category_name`; `program_name` + `categories`; `course_name` +
`programs`; `class_name` + `courses`.

**On create, once:**

```js
data: {
  tractionrec_id: "a0X…",         // the join key
  <title field>:  "Swim Lessons",  // category_name / program_name / course_name / class_name
  <parent field>: "7-…"            // categories / programs / courses — the one-to-many CSV
}
web: {
  pathPart: "swim-lessons",        // slugified from the name
  metaTitle, metaLinkText,
  parentZUID: "7-…"
}
```

Plus, where Traction Rec genuinely carries the same meaning
(`zestyFieldsFromTr` in `src/config.js`), and placeholders for any *required*
field still unset. See [sync-flow.md §3.1](sync-flow.md#31-what-a-created-item-is-seeded-with).

**On every run after that: nothing.** See
[sync-flow.md §1](sync-flow.md#1-the-shape-of-the-thing).

Everything else on the item — hero image, WYSIWYG body, SEO description,
display options — is the editor's, permanently.

---

## Snapshot file shape

```json
{
  "meta": {
    "tier": "class",
    "tractionrecObject": "TREX1__Course_Session_Option__c",
    "tractionrecId": "a0X1U000001abcUAA",
    "zestyItemZuid": "7-abc123def4-xyz789",
    "parents": ["a0C0x000000CourseAA"],
    "sourceModstamp": "2026-09-24T18:03:11.000+0000",
    "syncedAt": "2026-09-25T09:00:04.512Z",
    "hash": "sha256:…"
  },
  "data":   { "…": "flattened Traction Rec fields" },
  "parents": ["a0C0x000000CourseAA"],
  "prices": [{ "id": "…", "name": "Member", "amount": 85, "initialFee": null }]
}
```

`meta.hash` covers `data`, `parents` and `prices` — not `syncedAt`. That is
what lets an unchanged record produce no write.

### Class `data` keys

Field names are stripped of the `TREX1__` prefix. Where the derived name reads
badly, the tier declares an explicit key (`src/config.js`, the `[path, key]`
pair form).

| Key | Source | Notes |
| :--- | :--- | :--- |
| `name` | `Course_Option__r.Name` | the class's display name |
| `season` | `cso_Course_Session__r.Session__r.Name` | e.g. "Fall 2026" |
| `startDate` / `endDate` | Course Option | dates live only here — Course Session has none |
| `daysOfWeek` | `Day_of_Week__c` | **multipicklist**, semicolon-joined. 65% of options are multi-day ("Tuesday;Thursday") |
| `startTime` / `endTime` | the `*_Time_Formula__c` fields | the raw time fields are strings, inconsistently formatted. The formulas normalise to `18:00:00.000` |
| `ageMin` / `ageMax` | `Age_Min__c` / `Age_Max__c` | **not** `Min_Age`/`Max_Age`. Course carries no age fields at all |
| `instructor` | `Instructor__c` | free text, inconsistent ("Malik Jones" / "Malik" / "Malachi, Desmond, Malik"), ~291/945 populated. No lookup, so no bio or photo |
| `capacity` / `registered` / `spotsRemaining` | Course Option | `spotsRemaining` is the formula `Total_Capacity_Available__c`. **There is no `Available_Capacity__c` on this object** |
| `unlimitedCapacity` | Course Option | 25/945 are uncapped, where 0 spots does not mean full |
| `showCapacityOnline` | Course Option | TR's own directive for whether a spot count may be shown publicly. Honour it |
| `waitlistTotal` / `waitlistCapacity` | Course Option | |
| `registerUrl` | `Deep_Link_URL__c` | org-custom formula returning the working Experience Cloud registration URL. Do not construct this by hand |
| `blockingReasons` | `Course_Online_Availability__c` | always `null` for synced rows, since the query filters on it. Kept so the file states why it is publishable |
| `description` | `Course_Option__r.Description__c` | see the sanitising note below |

### Prices

Price is a second hop — Course Option → Product → Price Level — and it is
attached as an **array**, not a single number:

- **Course Option's Product is authoritative.** Course Session's Product is a
  per-facility placeholder named `"<Facility> Free Product"` carrying no price.
  863 of 933 junction pairs disagree between the two levels.
- The amount is `TREX1__Total_Billing_Schedule_Amount__c`. For class price
  levels `TREX1__Initial_Fee_Amount__c` really is null throughout — 0 of 50 on
  the publishable set, re-checked 2026-09-28. **That does not generalise:** on
  Day Pass products the price lives *entirely* in `Initial_Fee_Amount__c`
  ($15 adult / $13 teen / $11 youth) with `Total_Billing_Schedule_Amount__c` at
  $0, and membership products carry a $20 joining fee there. Any tier beyond
  classes has to read both fields.
- `TREX1__Price_Type__c` is `Member` / `Non-Member` and pairs cleanly on class
  price levels (24 / 25 across the publishable set), so the snapshot carries it
  as `priceType` and a card can label both rather than guess which is which.
- A Product carries several Price Levels (member / non-member / resident) and
  the service cannot know which applies: there is one fixed integration
  identity, so the site never knows who is viewing. Render the levels you want
  to show and let the registration deep link resolve entitlement after the
  hand-off.

---

## Seeding `[classes]` — two schema mismatches

The Zesty `classes` model constrains two fields in ways Traction Rec does not.

**`day_of_week` is a dropdown of single days** (`monday`…`sunday`, lowercase
keys) while `TREX1__Day_of_Week__c` is a multipicklist where **65% of options
are multi-day**. No dropdown value represents "Monday;Wednesday", so the field
is set only when Traction Rec names exactly one day, and left empty otherwise.
The real value always survives in the snapshot's `daysOfWeek`, which is what a
template should render. This is the schema finally meeting the broken
"Decision B" — single-day classes in day bands cannot hold.

**`enrollment_status` is a dropdown** (`open|full|waitlist|closed`) and
Traction Rec has no equivalent field, so it is derived: spots remaining, then
waitlist headroom, with uncapped options always `open`. It is one of the
volatile five, so it is seeded on create and never refreshed — the snapshot
stays the live source.

`member_price` and `public_price` come from `TREX1__Price_Type__c` on the
Product's price levels, which pair cleanly. `facility_location` has no source
at all and stays editorial.

⚠ Price levels are sometimes **named** for a different season than the class
using them (a Fall 2026 class priced by a "Summer 2" price level). The amounts
resolve correctly through the Product link; only the name is misleading. Do not
render a price level's `name`.

---

## Known gaps in the source data

Worth knowing before designing a template around a field that is always empty.

- **All copy above Course level is empty.** Program Category descriptions 0/9,
  Program descriptions 0/22. Course is 63/119 rich, Course Option 37/945. The
  catalog's upper tiers need copy written in Zesty; Traction Rec has none.
- **There is no Location anywhere.** No Location object is exposed, Course
  Option has no `Location__c` and no lookup — only a `Show_Location__c`
  boolean. If the site needs a facility name, it is a Zesty field.
- **Rich descriptions carry hardcoded inline styles** (red text, centering) and
  unescaped entities. Sanitise before rendering — the snapshot stores them
  verbatim, because stripping at sync time would be irreversible.
- **The many-to-many is not exercised.** No Program is tagged to more than one
  Category, and only 2 Course Options link to more than one Course Session. The
  schema permits it, so the service keeps `parents` as an array and links the
  item to `parents[0]`. If a second tag ever appears it shows up in the file as
  data rather than silently disappearing.
- **"Kickball" is online but untagged**, so it is invisible to a
  category-driven catalog. That is a content fix in Traction Rec, not a code
  fix here.
