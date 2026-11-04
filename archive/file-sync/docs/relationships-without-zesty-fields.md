# Relationships without Zesty fields

> **Question:** can the catalog hierarchy live in Traction Rec's snapshots
> instead of being copied into Zesty relational fields — and can Parsley still
> render it?
>
> **Answer: yes, and better than expected.** Parsley can read a snapshot file
> server-side. The constraint is narrower than "no Parsley": detail pages keep
> full server-side rendering, and only *listings* move to a different
> mechanism.
>
> Status: implemented: tier files (§2.0), root-level snapshot
> fields (§2.0a) and parent → children files (§2.0c). The sync still writes the relational fields on create — see
> [sync-flow.md](sync-flow.md).

---

## 1. Why change anything

Today the sync writes three Zesty relational fields on create:

| Zesty field | from Traction Rec |
| :--- | :--- |
| `programs.categories` | `Program_Category_Tag` junction |
| `courses.programs` | `Course.Program__c` lookup |
| `classes.courses` | `Course_Session_Option → Course_Session → Course` |

All 203 links verified correct. The problem is not accuracy, it is **ownership
ambiguity**. An editor opening a Class in the Manager sees `courses`,
`class_start_date`, `member_price` and `spots_remaining` sitting in editable
inputs. They are not editable in any meaningful sense: the next sync does not
overwrite them (by design), so an edit silently persists in Zesty while
Traction Rec says something else, and the two drift with no warning to anyone.

A field that looks editable and is not is worse than a field that is absent.

The stated direction is therefore: **Zesty holds the `tractionrec_id` plus the
web/SEO fields it genuinely owns (URL, meta title, meta description, hero
image, editorial copy). Everything else is read from the snapshot.** This
document covers the relationships only, as the first step.

---

## 2. What Parsley can actually do — tested, not assumed

⚠️ **Everything from §2.1 to §2.3g is superseded by §2.0 for relationships.**
It documents what Parsley *can* do, which matters for server-rendering a detail
page and for knowing the traps — but the relationship problem itself dissolves
once the data is published per tier rather than per record.

Two separate mechanisms, with different limits. Both tested against the live
instance, because the official docs are unreliable here:
one documented JSON pattern
(`api.json.get({field})`) does not work on this instance.

### 2.0 The short answer: `tractionrec_id` + the Traction Rec data is enough

**No parent record, no index, no children files, no relational field.**

Every Traction Rec record already carries its own parent — a Course snapshot
holds `program: "a31a…"`, a Class snapshot holds `courseId: "a1za…"`. The
relationship is not missing from the data; it was never missing. The only
question is whether the data is *reachable* in one request.

Publishing one snapshot per record is what made it unreachable: answering
"which courses are in this program" then means fetching all 119 of them.
Everything in §2.3b–g exists to work around that, and the workarounds were the
complexity. **The fix is to publish one file per tier instead.**

**Implemented** — `src/sync/tier-files.js`, written on every run. Measured live:

```
/tractionrec/program_categories.json     9 rows    1.2 KB gzipped
/tractionrec/programs.json             20 rows    2.3 KB gzipped
/tractionrec/courses.json             118 rows   31.2 KB gzipped
/tractionrec/classes.json               65 rows   14.3 KB gzipped
                                            ---------------------
                          entire catalog       49 KB gzipped
```

Each row is the same object as the per-item snapshot: Salesforce's fields at
the root, the sync's bookkeeping under `meta` (§2.0a explains why the root).
The earlier 24 KB estimate measured the bare records; carrying `meta` per row
doubles it. Still small, and it means a consumer holding a tier file needs
nothing else — `meta.zestyItemZuid` gets it back to the CMS entry.

Each row is Salesforce's own record (§2.0b), so its parent is already there:
`TREX1__Program__c` on a course, `TREX1__cso_Course_Session__r.TREX1__Course__c`
on a class. Only Program needs a key added, from the junction. Then, in the React components that already do the fetching:

```js
// a program page listing its courses
fetch("/tractionrec/courses.json")
  .then(r => r.json())
  .then(rows => rows.filter(c => c.TREX1__Program__c === d.tractionrecId));

// a course detail page — same file, already in the browser cache
rows.find(c => c.Id === d.tractionrecId);
```

| | |
| :--- | :--- |
| Zesty fields holding Traction Rec data | `tractionrec_id`, nothing else |
| files | **4**, replacing 212 per-item + 4 index + 59 children + 5 Parsley endpoints |
| relationship source | Traction Rec's own parent id, in each record |
| many-to-many | `TREX1__Program_Category__c` is an **array**; JS `.includes()` — no operator limits, because this is JavaScript |
| re-parenting in TR | followed automatically — the file is rewritten every run |

Verified end to end on `/test-page/`: filtering `courses.json` in the browser
returns the same 8 Basketball courses, in the same order, as the Zesty
relational field rendered by Parsley beside it. One request, ~680 ms cold.

**Why keep per-item files at all?** Only one reason: `{{ include }}` cannot
filter, so a page that wants its own record inlined as a JSON payload
(`{{ include /tractionrec/classes/{this.tractionrec_id}.json }}`) needs a file per
item. Since §2.0a, Parsley can server-render a detail page from the *tier*
file instead, so the per-item files are now optional.

**The scaling shape**, so it is a conscious choice: `courses.json` is 97 KB raw
and grows linearly. At today's size it is trivial. At ten times the catalog it
would be ~180 KB gzipped, which is when per-parent files start earning their
keep. They are not needed now.

---

### 2.0a Can Parsley render the relationship from the saved data?

**Yes, for three of the four tiers, since the file format changed.** The snapshot used to wrap the record in an envelope; it now
puts Salesforce's fields at the root of each row:

```
before  { "meta": { "hash": … }, "data": { "Id": "a1za…", "Name": "…", "TREX1__Program__c": "a31a…" } }
after   { "Id": "a1za…", "Name": "…", "TREX1__Program__c": "a31a…", "meta": { "hash": … } }
```

Field names and values are untouched. Only the envelope moved, and the sync's
own bookkeeping (`hash`, `syncedAt`, `zestyItemZuid`, …) stays nested under
`meta`. Implemented in `buildSnapshot()` (`src/sync/shape.js`), with tests
asserting that no Salesforce field sits below the root and that a key clash
with `meta`/`prices`/the relation key fails loudly instead of overwriting.

#### Why we changed it: `api.json.get` reads one level deep

With the envelope, `api.json.get` fetched and iterated the files (all 118
course rows) but reading `{{r.data.Name}}` **crashed the whole page**. This
applied equally to per-item and tier files. Isolated on fixtures,
one probe per page render because a crash takes the page down:

| probe inside `each api.json.get(…) as r` | result |
| :--- | :--- |
| top-level scalar on a row that *also* holds nested values (`{{r.Id}}`) | ✅ renders |
| dotted read into a nested object (`{{r.data.Name}}`) | ❌ crash |
| printing a nested object (`{{r.data}}`) | ❌ crash |
| printing a nested array (`{{r.list}}`) | renders the literal `Array` |
| object root instead of array root, top-level scalar | ✅ renders (one pass) |
| object root, dotted read | ❌ crash |
| `{{each r.data as d}}` over a nested object | loops zero times, silently |

Nested values being *present* is harmless, and so is an object root. There
is no second-level syntax at all: Parsley binds a fetched row as a one-level
key → scalar map. The old files failed for one reason: **they had no
top-level scalars.** Every root key was `meta` or `data`, so every field
Salesforce returned sat exactly one level below what Parsley can see.

**Why remove the envelope rather than publish a flat copy.** The first fix
was a second file per tier (`course.flat.json`) with `data` hoisted to the
root. That meant two files with the same data, the second hand-published and
going stale. Removing the envelope makes the one set of files the cron already
writes readable by both JavaScript and Parsley, and `program_category`,
`program` and `course` have no nested fields once it is gone. `course.flat.json`
has been deleted.

#### What it gives, verified on `/test-page/`

Relationship listing, server-rendered, from the same file §2.0's JavaScript
reads. Same 8 Basketball courses as the Zesty relational field (§3):

```
{{each api.json.get(https://kroc.zesty.dev/tractionrec/courses.json) as c}}
  {{if {c.TREX1__Program__c} == (a31a6000000EhmvAAC)}}
    {{c.Name}}
  {{end-if}}
{{end-each}}
```

A detail page, from the tier file, with no file of its own shape: filter to
the row whose `Id` is the item's `tractionrec_id` (§5 renders a course's
`TREX1__Rich_Description__c` as real HTML):

```
{{each api.json.get(https://kroc.zesty.dev/tractionrec/courses.json) as c}}
  {{if {c.Id} == ({this.tractionrec_id})}}
    <h1>{{c.Name}}</h1> {{c.TREX1__Rich_Description__c}}
  {{end-if}}
{{end-each}}
```

⚠️ `({this.tractionrec_id})` in parentheses is safe **only because Salesforce
ids contain no hyphen**. See the hyphen trap.

Per-item files behave identically (`{{r.Name}}` renders from
`/tractionrec/courses/<id>.json`).

**`include` vs `api.json.get` for a detail page:** `include` puts the raw JSON
in the HTML, a server-rendered *payload* to hand to JavaScript.
`api.json.get` lets Parsley render the *content*, which is what a crawler
reads. Only the second is server-side rendering in the sense that matters for
SEO.

#### The per-row pattern: native `each` + one file per row

The earlier test, restored on `/test-page/` §6 against the real per-item files:

```
{{each courses as c sort by c.course_name asc}}
  {{c.course_name}}
  {{each api.json.get(https://kroc.zesty.dev/tractionrec/courses/{c.tractionrec_id}.json) as s}}
    {{s.Name}} {{s.TREX1__Program__c}}
  {{end-each}}
{{end-each}}
```

- A **loop alias does interpolate into an `api.json.get` URL** (`{c.tractionrec_id}`),
  unlike `include`, where it renders empty.
- **Inside the inner loop the outer alias is gone.** `c.course_name` is empty
  and `c.getUrl()` silently returns the *current page's* URL. Read what you
  need from `c` before opening the inner loop. `this.*` does survive.
- **It costs one sequential fetch per row.** Filtering all 119 courses to
  Basketball this way returns the correct 8 but took **71 s** to render on
  stage. The single `courses.json` fetch takes about 1 s. Use the
  per-row pattern only for a few rows already chosen in Zesty (a curated
  "featured" field), never for "every child of X".

#### What is still out of reach: anything nested

| | Parsley | JavaScript |
| :--- | :--- | :--- |
| every field on `program_category`, `course` | ✅ | ✅ |
| every field on `program` except its category array | ✅ | ✅ |
| `program.TREX1__Program_Category__c` (array, from the junction) | ❌ prints `Array` | ✅ `.includes()` |
| `class` root fields (`Id`, `Deep_Link_URL__c`, `TREX1__Course_Option__c`, …) | ✅ | ✅ |
| `class` under `TREX1__Course_Option__r` (name, dates, days, ages, capacity) | ❌ | ✅ |
| `class`'s parent course, `TREX1__cso_Course_Session__r.TREX1__Course__c` | ❌ so no course → class filter | ✅ |
| `class.prices` (array of price levels) | ❌ | ✅ |

`class` nests because that is how Salesforce returns a relationship query, and
the sync keeps Traction Rec's structure (§2.0b). So **category → program and
course → class cannot be filtered in Parsley** from the synced files. Program
and course pages can list their children server-side, and class pages cannot
render their details server-side.

If they must, the remaining option is a flat projection for `class` alone,
with nested names joined by `__` (a dot is parsed as a path and crashes):
`TREX1__Course_Option__r.TREX1__Age_Min__c` →
`TREX1__Course_Option__r__TREX1__Age_Min__c`. `/tractionrec/class.flat.json` is
exactly that, **published by hand as a demo. The sync does not generate it, so
it goes stale.** Whether to wire it in is open (§7). Category → program would
need the array expressed as scalars. That is not yet designed.

---

### 2.0c Parent → children files

The sync also writes, for every parent, a file holding **only its own
children**: `src/sync/children-files.js`, run after all tiers.

```
/tractionrec/
  program_categories/<id>/programs.json     9   programs tagged into that category
  programs/<id>/courses.json               20   that program's courses
  courses/<id>/classes.json               118   that course's classes
                                          ---
                                          147   every parent has one, [] when empty
```

A page reads its own small file instead of filtering a whole tier file. The
largest is Group Swim Lessons' 29 courses at 28 KB (6 KB gzipped), against
134 KB for `courses.json`. Rows are the same objects as the tier file's,
copied in full.

```
{{each api.json.get(https://kroc.zesty.dev/tractionrec/programs/{this.tractionrec_id}/courses.json) as c}}
  {{c.Name}}
{{end-each}}
```

**Naming: plural, REST-style.** Collections are plural and a
child collection sits under its parent: `programs.json`, `programs/<id>.json`,
`programs/<id>/courses.json`. Salesforce's own object names are singular
(`TREX1__Course__c`), but these paths are not Traction Rec data. They are the
site's URL scheme, and everything else on the site is plural (the Zesty models,
the existing custom endpoints). The tier keys are the same plural words
(`--tiers=classes`, `meta.tier: "classes"`), so the folder, the CLI and the
file contents cannot drift apart. One name being both a file
(`programs/<id>.json`) and a folder (`programs/<id>/`) was verified first:
Zesty serves both and Parsley reads both.

**What it adds beyond size:** category → programs now works in Parsley. From
the tier file it could not, because a program's categories are an array. The
sync resolves the membership while it builds the file. Course → classes is read
in JavaScript, since class rows keep Salesforce's nested `__r` objects
(decided: no flattening).

**The rules**, each closing a way for a file to go wrong:

| rule | what it prevents |
| :--- | :--- |
| every synced parent gets a file, `[]` when empty | a course that loses its last class keeping a file of old classes; a page unable to tell "no children" from "missing file" (a 404 is one silent empty pass) |
| every file rebuilt from all rows, every run | stale membership. With many-to-many, untagging a program drops it from that category's file and leaves the other's alone, with no per-change bookkeeping |
| full rows, not ids | the one-fetch-per-row pattern, 71 s for 119 courses (§2.0a, test page §6) |
| rows sorted by name, then Id | the same members producing a new hash and a pointless rewrite |
| written only when the content hash changes, and the file still exists | 147 writes per cron run; a deleted file being trusted forever |

The content hash covers each row's own hash, its Zesty item and the order,
not `syncedAt`. The same check now applies to the four tier files, which used to
be rewritten on every run. Measured: a second run after a full sync writes
nothing at all.

**Many-to-many.** A program tagged into two categories is copied in full into
both files. The copies are identical because Traction Rec's link object
(`TREX1__Program_Category_Tag__c`) carries no data of its own, only the two
lookups and `TREX1__Legacy_Id__c`. If it ever gains a
per-link field such as display order, that field cannot live on the program
row and this design has to change. No program is in more than one category in
the whole org today (20 tag rows for 20 programs), so the unit tests cover it
with a fixture, including untagging.

The reverse direction is a list: a program's categories are the
`TREX1__Program_Category__c` ids on its record, looked up in
`program_categories.json` (9 rows) in JavaScript. A page combining categories
should de-duplicate programs by `Id`.

**Partial runs.** `--tiers=classes` still rebuilds the course → classes files.
A tier not in the run is read back from its published tier file, because every
course needs a file, empty or not.

---

### 2.0b Naming: Traction Rec's, not ours

The published record is **exactly what Salesforce returns**. No renaming, no
flattening, no derived keys — only the `attributes` envelope (the API's own
`type`/`url`) is stripped, at every depth.

```json
// /tractionrec/courses/a1za….json
{ "meta": { … },
  "data": {
    "Id": "a1za60000026CerAAE",
    "Name": "Kids Boxing",
    "TREX1__Program__c": "a31a6000000EhmsAAC",
    "TREX1__Available_Online__c": true
  } }
```

Earlier cuts of this file renamed fields — `spotsRemaining`, `registerUrl`,
`programs` — which read more nicely and were the wrong call:

- **Every rename is a mapping that has to be maintained**, and it can drift
  from the source silently. This project already shipped one such bug: an
  invented `Available_Capacity__c` that does not exist on the object, which
  only surfaced when a live query 400'd.
- Cross-referencing Salesforce becomes exact. A field in the JSON is the field
  in the describe, with no lookup table in between.
- Nested `__r` objects are kept because that nesting is Traction Rec's own
  structure, and the consumer is JavaScript, which handles it natively.

**Exactly one key is added that Salesforce does not return.** A Program record
has no category field — the link lives in the
`TREX1__Program_Category_Tag__c` junction — so it is attached at the top level,
named after that junction's own lookup field:

```json
{ "meta": {…}, "data": {…}, "TREX1__Program_Category__c": ["a2za…"] }
```

Courses and Classes get nothing added: their parent is already in the record
Salesforce returns (`TREX1__Program__c`, and
`TREX1__cso_Course_Session__r.TREX1__Course__c`). It stays an **array**, since
Program ↔ Category is a real many-to-many.

**The cost, stated plainly:** keys are verbose, and a component reads
`c.TREX1__Course_Option__r.TREX1__Age_Min__c` rather than `c.ageMin`. That is
the price of having no mapping layer. If it proves too painful, the place to
fix it is one adapter function in the front end — not in the stored data, where
a rename can silently diverge from the source.

---

### 2.1 `include` — reads a snapshot file, but only as text

`{{ include }}` inlines another view's rendered output. A snapshot is an
`ajax-json` view, so Parsley can read one **server side** with no HTTP call.

| Form in an include path | Result |
| :--- | :--- |
| literal path | ✅ inlines the file |
| `{get_var.id}` | ✅ resolves the query param |
| `{this.tractionrec_id}` | ✅ **resolves the item field** |
| `{c.tractionrec_id}` inside `{{each … as c}}` | ❌ renders empty |
| `{$t}` after `{{ $t = "…" }}` | ❌ renders empty |
| `{{ $t = c.field }}` inside a loop | ❌ stores the literal string `c.field` |
| a path that does not exist | ❌ renders empty — **fails silently** |

### 2.2 `json()` — iterates real structure, but only from a FIELD

`json()` parses JSON **stored in a content field** into something Parsley can
walk. This is the capability that makes server-rendered listings possible at
all.

| Expression | Data shape | Result |
| :--- | :--- | :--- |
| `{{each {this.f}.json() as i}}` | field is a root array | ✅ iterates |
| `{{each {this.f}.json(program) as p}}` | `{program:[…]}` | ✅ **iterates a top-level array key** |
| `{{each {this.f}.json(tiers.program) as p}}` | `{tiers:{program:[…]}}` | ❌ empty — **no nested arrays** |
| `{{this.f.json(n)}}` | `{n:2}` | ✅ `2` |
| `{{this.f.json(flatobj.name)}}` | `{flatobj:{name:"Gamma"}}` | ✅ **dotted scalar works** |
| `{{this.f.json(tiers.program.0.title)}}` | indexed path | ❌ empty |
| `{{each {this.f} as i}}` (no `.json()`) | any | ❌ empty — `.json()` is required |
| `{{each {include /x.json}.json() as i}}` | — | ❌ **empty — `json()` cannot read an include** |

**Filtering inside a `json()` loop:**

| | |
| :--- | :--- |
| inner `{{if {p.parent} == 'cat1'}}` | ✅ filters correctly |
| `{{each … as p where p.parent == 'cat1'}}` | ⚠️ **silently ignored — returns every row** |

That last line is a trap worth stating twice. A `where` clause on a `json()`
loop does not error and does not filter; it returns the whole array. Anyone
carrying a `where` over from a normal `{{each}}` will ship an unfiltered list
that looks like working code. **Filter with an inner `{{if}}`.**

### 2.3 `api.json.get()` — Parsley makes an HTTP call

**This overturns a premise recorded across the project**: that Parsley has no
outbound HTTP. It does.

```
{{each api.json.get(https://kroc.zesty.dev/tractionrec/_index/programs.json) as p}}
  <a href="{{!p.path}}">{{!p.title}}</a>
{{end-each}}
```

| | Result |
| :--- | :--- |
| full URL, own domain, root array | ✅ iterates |
| **external domain** (`jsonplaceholder.typicode.com`) | ✅ **iterates — arbitrary outbound HTTP** |
| URL built from `{this.zuid}` | ✅ resolves |
| URL built from `{get_var.f}` | ✅ resolves |
| a relative path instead of a URL | ❌ `error:call:1` — the engine's own message says it wants a full URL |
| outside an `{{each}}` | ❌ "JSON access must be accessed through an each loop" |
| a value that is a **nested object** (`{{o.meta}}`) | ❌ **crashes the whole page** |
| `where` clause | ⚠️ **silently ignored**, same as `json()` |
| a URL that 404s | ⚠️ one empty pass, **no error** |

Two hard constraints follow:

- **Fetched rows must be flat.** Reading a value that is itself an object is
  not "empty", it is a Parsley error that takes the page down. A root array of
  scalar-valued objects is the only safe shape.
- **Failure is invisible.** A dead URL and an empty list render identically.
  Anything depending on this needs a "did we get rows" check in the template.

Measured cost: a page doing one fetch rendered in ~0.7 s, against ~0.65 s for
serving the JSON file alone. One fetch is not obviously expensive, but that is
a single small same-domain file — it is not evidence that ten fetches, or a
slow external service, would be fine.

### 2.3b Proven end to end — the index render matches the field render

Built from the live synced catalog and rendered on
`/test-page/`: a simulated Program detail page listing its Courses, with the
`courses.programs` relational field read **nowhere**.

| | |
| :--- | :--- |
| **Section B** — `api.json.get(/tractionrec/_index/course.json)` filtered on `parent == the program's trId` | 8 courses |
| **Section D** — the old way, `{{each courses as zc where FIND_IN_SET('7-feeac0fae9-28d0cs', zc.programs)}}` | 8 courses |

**Identical** — same eight courses, same order, same Traction Rec ids. The
mechanism works.

**Comparison syntax matters, and the failures are silent:**

| Form | |
| :--- | :--- |
| `{{if {c.parent} == (a31a6000000EhmvAAC)}}` | ✅ literal in parens |
| `{{if {c.parent} == ({get_var.program})}}` | ✅ **interpolated in parens** |
| `{{if {c.parent} == '{get_var.program}'}}` | ❌ 0 matches |
| `{{if {c.parent} == {get_var.program}}}` | ❌ 0 matches |

**Nested fetches work**, including the outer loop's alias in the inner
comparison — `{{each … as c3}}…{{each api.json.get(…) as cl}}{{if {cl.parent}
== ({c3.trId})}}`. That renders Program → Courses → Classes in one server-side
pass. It is also the expensive pattern:

| page | fetches | render |
| :--- | ---: | ---: |
| Program + its courses | 3 | ~0.9–2.0 s |
| …plus classes nested under each course | 11 | ~1.6–3.4 s |

Roughly +0.1 s per fetch, issued serially, on small same-domain files. Fetch
whole arrays and filter in the template; reach for a nested fetch only when the
page genuinely needs the third level.

### 2.3c Four ways to render "the courses under this program", measured

All four produce the **same correct 8 rows**. They differ enormously in cost.

| approach | fetches | render | verdict |
| :--- | ---: | ---: | :--- |
| Zesty relational field + `FIND_IN_SET` (today) | 0 | baseline | works — but the field is what we are removing |
| **Per-row fetch** inside `{{each courses as c}}`, URL built from `{c.tractionrec_id}` | **119** | **~10 s (80 s cold)** | ❌ correct but unusable |
| Global `_index/course.json`, filtered in-template | 1 | ~0.9 s | ✅ |
| **Per-parent `_children/program/<trId>.json`** | **1** | **~0.8 s** | ✅ **simplest — no filter at all** |

**The per-row pattern is the intuitive one and it does work.** A loop alias
*does* interpolate in an `api.json.get()` URL — verified: looping all 9
categories and fetching `/tractionrec/_flat/{c.tractionrec_id}.json` resolved
exactly the two that had files. But one HTTP call per row in the model, issued
serially, is ~10 s for a 119-row model. It is the right shape for a **detail
page** (one item, one fetch) and the wrong shape for a listing.

**Why the nested loop exists.** `api.json.get()` cannot be used outside an
`{{each}}` — Parsley refuses it outright with *"JSON access must be accessed
through an each loop"*. The inner loop is not iterating anything; it is the
only accessor for fetched JSON, and for a one-row file it runs exactly once.
So the fetch count comes from the **outer** loop's 119 iterations, not from the
nesting. Approaches that fetch once, outside any native loop, need no nesting
at all — the `{{each}}` that wraps the fetch *is* the row loop.

⚠️ **The outer Zesty alias is lost inside the fetched loop, silently.** Within
`{{each api.json.get(…) as s}}` nested in `{{each courses as c}}`:

| | |
| :--- | :--- |
| `{c.tractionrec_id}` in the **URL** | ✅ resolves |
| `{{c.course_name}}` rendered | ❌ **empty** |
| `{{c.getUrl()}}` rendered | ❌ **returns the CURRENT page's URL** (`/test-page/`) |
| `{{s.anything}}` from the fetch | ✅ works |

That second failure is the dangerous one: every link in such a listing points
at the page itself, with no error. **Consequence: a row must render entirely
from the fetched JSON.** The file therefore has to carry the Zesty `path` and
`title` — which is why the index rows carry them. That is not gratuitous
complexity; it is forced by this limitation.

#### The recommendation: per-parent children files

```
/tractionrec/_children/program/<programTrId>.json
[ { "trId": "a1za…", "title": "Basketball Academy", "path": "/basketball-academy/" }, … ]
```

```
{{each api.json.get(https://kroc.zesty.dev/tractionrec/_children/program/{this.tractionrec_id}.json) as c}}
  <a href="{{!c.path}}">{{!c.title}}</a>
{{end-each}}
```

No `{{if}}`, no filter, no global index to reason about — the sync simply
writes, for each program, the list of its courses. One fetch. The template is
shorter than the `FIND_IN_SET` version it replaces.

Cost: **59 files** for the current catalog (7 + 18 + 34), rewritten every run —
including empty ones, or a parent that lost its last child keeps serving stale
rows (§2.3e). 18 of them were built and proved out in this test.

### 2.3d The snapshot format has to change

The snapshots the sync writes today are **completely unreadable** by
`api.json.get()`. Checked against a live class snapshot:

```
{ "meta": {…}, "data": {…}, "parents": […], "prices": […] }
    ^OBJECT      ^OBJECT      ^ARRAY         ^ARRAY
```

All four root keys are non-scalar, and reading a non-scalar **crashes the
page**. So every one of them is fatal — there is nothing in the current file
Parsley can touch.

**The good news: the payload is already flat.** `data` holds 30 fields and
**zero** of them are objects or arrays. The problem is the wrapper, not the
content. The restructure is therefore small:

| change | why |
| :--- | :--- |
| wrap the whole record in a **root array** | an object root loops once and exposes nothing |
| hoist `data.*` to the root | already all scalars — a straight move, no flattening |
| hoist the scalar `meta.*` (prefixed, e.g. `_trId`, `_zestyZuid`, `_syncedAt`) | keeps provenance without a nested object |
| `parents[0]` → `parent` string | arrays are unreachable; no program has two categories today |
| `prices[]` → `memberPrice` / `publicPrice` | **the only real loss** — see below |

```json
[ { "name": "Swim Level 2", "startDate": "2026-10-05", "daysOfWeek": "Monday;Wednesday",
    "spotsRemaining": 12, "registerUrl": "https://…", "parent": "a1za…",
    "memberPrice": 78.2, "publicPrice": 92,
    "_trId": "a1ua…", "_zestyZuid": "7-…", "_syncedAt": "2026-09-30T…" } ]
```

**Prices are the one thing that genuinely does not survive.** A Product can
carry more than the Member / Non-Member pair, and an array of price levels
cannot be represented. Two scalars cover every class in the current data
(`Price_Type__c` pairs cleanly, 24/25 across the publishable set). If a page
ever needs the full ladder, give it its own file rather than nesting.

#### What each consumer needs

| file | for | must carry |
| :--- | :--- | :--- |
| `/tractionrec/<tier>/<trId>.json` | a **detail page**, 1 fetch | Traction Rec fields only |
| `/tractionrec/_children/<tier>/<parentTrId>.json` | a **listing**, 1 fetch | + `path` and `title` |

That difference is not arbitrary. **`{{this.*}}` survives inside a fetched
loop** — verified: `{{this.zuid}}` and `{{this.getUrl()}}` render correctly
inside `{{each api.json.get(…) as s}}`. So a detail page can freely mix its own
Zesty fields with fetched Traction Rec data, and its flat file needs no
duplicated title or URL. A **listing** has no such handle — the outer loop
alias is lost (§2.3c) — so its rows must carry the Zesty `path` and `title`
themselves.

⚠️ `limit` is silently ignored on a fetched loop, exactly like `where`. Slice
the data when the sync writes the file, not in the template.

### 2.3e Many-to-many: why children files, not an index

A fair objection to the index form: it stores **one** `parent` per row, so what
happens when something has two? Traction Rec's schema permits it — Program ↔
Category is a junction, and a Course Option can sit under several Course
Sessions.

**Tested whether a multi-valued field can be matched at all.** Fixture rows
carrying a CSV `parents`, filtered for `catFitness`:

| form | result |
| :--- | :--- |
| `{{if {r.parents} == (catFitness)}}` | ❌ empty — exact match only, a CSV never equals one member |
| `{{if {r.parents} LIKE (%catFitness%)}}` | ❌ empty — not supported |
| `{{if FIND_IN_SET('catFitness', {r.parents})}}` | 🚨 **returned ALL THREE rows**, including one whose parents are `catSports` |

That last line is the worst failure found anywhere in this investigation.
`FIND_IN_SET` inside an `{{if}}` on fetched JSON is **not evaluated** — it is
simply truthy, so the filter passes everything while looking exactly like
working code. It is the `where`-is-ignored trap again, but silently producing
*wrong rows* rather than *all rows in an obvious way*.

**Conclusion: a multi-valued parent cannot be filtered on fetched JSON at all.**
There is no working operator. So the index form genuinely cannot express
many-to-many, and the objection is correct.

**Children files sidestep it entirely.** Denormalising by parent *is* how you
represent a many-to-many without arrays: a program in two categories is simply
written into both category files. No `parents` field, no matching, no operator
needed — the file you fetch already *is* the answer.

| | many-to-many | filter needed |
| :--- | :--- | :--- |
| `_children/<tier>/<parentTrId>.json` | ✅ item appears in each parent's file | none |
| `_index/<tier>.json` + `parent` scalar | ❌ second parent lost | inner `if` |

#### "Isn't this manually tracking the parent?"

The opposite, and this is worth being clear about. The children files are
**derived from Traction Rec and rewritten on every run**, so they cannot drift
from it. The thing that *is* write-once-and-never-updated is the **Zesty
relational field we have today** — set at create, never touched again, so it
does not follow a re-parent in Traction Rec and nothing detects that. Moving to
children files makes the relationship *less* hand-maintained, not more.

#### The real maintenance risk

Not multi-parent — **stale files**. If a course moves from program A to B, A's
file must be rewritten without it, and if a parent loses its last child its
file must become `[]` rather than being skipped. The sync never deletes
anything (by design), so a skipped file would keep serving its old rows
forever. **Every children file must be rewritten every run, including empty
ones.** That is the one thing the implementation has to get right.

Scale is modest: **59 children files** total for the current catalog — 7
categories with programs, 18 programs with courses, 34 courses with classes.

### 2.3f The simplest answer: a parent **id** field, no extra files

Everything above assumes the relationship has to travel through a fetched file.
It does not. Parsley's **native** `{{each}}` over a Zesty model supports a
`where` clause, and that clause works fine against a plain text field holding a
Traction Rec id.

Tested against the live `courses` model:

| form | result |
| :--- | :--- |
| `where FIND_IN_SET('a1za…Cf4AAE', c.tractionrec_id)` | ✅ exactly 1 row |
| `where FIND_IN_SET('{get_var.tid}', c.tractionrec_id)` | ✅ interpolates |
| `where c.tractionrec_id = 'a1za…'` (**single** `=`) | ✅ |
| `where c.tractionrec_id LIKE '%{get_var.tid}%'` | ✅ |
| `where FIND_IN_SET('NOSUCHID', c.tractionrec_id)` | ✅ **correctly empty** |
| `where c.tractionrec_id == '…'` (double `==`) | ❌ empty — use single `=` |

**That negative case is the important one.** On a *content model* `FIND_IN_SET`
genuinely evaluates — a non-matching id returns nothing. On *fetched JSON* the
same function is always-true and silently returns every row (§2.3e). Same
spelling, opposite behaviour, depending on what it is filtering.

So the whole relationship problem collapses to **one extra text field**:

```
[courses]  tractionrec_id          a1za…            (already exists)
           parent_tractionrec_id   a31a…            (new — CSV if ever multi)
```

```
{{each courses as c where FIND_IN_SET('{this.tractionrec_id}', c.parent_tractionrec_id) sort by c.course_name asc}}
  <a href="{{c.getUrl()}}">{{!c.course_name}}</a>
{{end-each}}
```

| | |
| :--- | :--- |
| extra files | **none** |
| HTTP fetches | **none** |
| `sort by`, `limit`, pagination | ✅ all native, unlike fetched loops where `where` and `limit` are ignored |
| `{{c.getUrl()}}` and `{{c.course_name}}` | ✅ work — no nested loop, so no lost alias |
| many-to-many | ✅ CSV + `FIND_IN_SET`, exactly how Zesty's own one-to-many is stored |

**Why this is not the thing we set out to remove.** The existing
`courses.programs` field holds a **Zesty ZUID**, is written once at create, and
never follows a re-parent in Traction Rec. `parent_tractionrec_id` holds a
**Traction Rec id** — the same category of machine-owned data as
`tractionrec_id`, which the stated direction already accepts — and the sync
rewrites it on every run, so it *does* follow. It is strictly less
hand-maintained than what exists today.

It does require refining the never-update rule: the sync owns
`tractionrec_id` and `parent_tractionrec_id` and rewrites them every run;
every other field on the item remains the editor's, untouched. That is a
narrower and more defensible rule than "never update anything", which was only
ever a proxy for "never clobber editorial content".

**This supersedes §2.3c–e for relationships.** Children files and the index
remain useful for the *value* fields a detail page needs, and for the class
finder — but not for expressing the hierarchy.

### 2.3g The actual answer: the listings are already JavaScript

Every option above tries to make **Parsley** resolve the relationship. That is
solving a problem this codebase does not have.

`catalog.jsx` already fetches every catalog listing client-side:

```js
// ProgramsSection — the category page's Programs list, as it exists today
params.set("category", d.categoryZuid);
fetch("/custom-endpoints/programs.json?" + params.toString())
```

Categories, programs, courses and classes are **all** rendered this way. The
`categories` page view even says so in its header comment. Parsley's only job
on these pages is to hand the React component the *current item's* fields —
`zuid`, title, hero, intro — which it does with `{{this.*}}`.

So the relationship never has to pass through Parsley at all. The change is:

```js
// the same component, pointed at the sync's output
fetch("/tractionrec/_children/program_category/" + d.tractionrecId + ".json")
```

and in the page view, one line changes:

```
- zuid: "{{this.zuid}}",
+ tractionrecId: "{{this.tractionrec_id}}",
```

#### Why this is *less* complexity, not more

The children files are not additive — they **replace** Parsley endpoints:

| removed | added |
| :--- | :--- |
| `custom-endpoints/programs.json` | `_children/program_category/<trId>.json` |
| `custom-endpoints/courses.json` | `_children/program/<trId>.json` |
| `custom-endpoints/classes.json` | `_children/course/<trId>.json` |
| `custom-endpoints/catalog-parents.json` | — (the child row carries its parent) |
| `custom-endpoints/class-finder.json` | `_index/class.json` |

Five hand-written Parsley endpoints go away. What replaces them is static JSON
with no query to run, so it is also faster to serve.

The component gets simpler too. Today `start` / `limit` / `q` are URL params
that Parsley turns into a SQL-ish query; against a scoped file they are array
operations on at most 29 rows (the largest parent is Group Swim Lessons).
Search and pagination become `.filter()` and `.slice()`.

#### What it costs

- **No Zesty field of any kind** — not a relational field, not a parent id.
  Only `tractionrec_id`, which the stated direction already accepts.
- **SEO: unchanged.** These listings are client-rendered *today*. Nothing
  regresses, because there is nothing server-rendered to lose. If listing SEO
  is ever wanted, that is a separate decision about the whole React shell, not
  about this integration.
- **Detail pages keep their server-side option** — `{{ include
  /tractionrec/<tier>/{this.tractionrec_id}.json }}` puts a single item's data
  in the HTML with no fetch (§2.1), which is where SEO actually matters.

### 2.4 The boundary this draws

| Mechanism | Reaches | Yields | Interpolates |
| :--- | :--- | :--- | :--- |
| `include` | a **view** by path | raw text | `{this.*}`, `{get_var.*}` |
| `json()` | a **field** | structure | n/a |
| `api.json.get()` | **any URL** | structure | `{this.*}`, `{get_var.*}` |

`json()` cannot parse what `include` inlines — those two do not compose. But
`api.json.get()` makes that irrelevant: it reaches a snapshot **file** *and*
yields structure. It is strictly the most capable of the three, and it is what
the design below is built on.

### 2.5 Live worked example

**https://kroc.zesty.dev/test-page/** — a simulated Program page listing its
Courses three ways: filtered from `courses.json` in the browser, the Zesty
relational field beside it as a control (identical output), and the per-item
`include` that server-renders a single record.

Scratch fixtures from this investigation have all been deleted:
`_index/`, `_children/`, `_flat/`, `_probe/` and
`/custom-endpoints/tr-include-test.json`. Each existed to work around a
constraint that no longer applies:

| gone | why it existed | superseded by |
| :--- | :--- | :--- |
| `_index/<tier>.json` | a lookup so a listing need not fetch 119 files | `/tractionrec/<tier>.json`, which carries the whole record |
| `_children/<tier>/<parentTrId>.json` | one fetch per parent, and many-to-many | **reinstated** as `<parentTier>/<parentId>/<childTier>.json` (§2.0c), now generated by the sync, written for every parent and rebuilt from all rows each run |
| `_flat/course/<trId>.json` | scalar-only rows, the only shape `api.json.get` can read | nothing; Parsley is not the consumer |
| `_probe/*`, `tr-include-test.json` | syntax probes | the findings, recorded above |

The instance now holds exactly what the sync writes: one snapshot per record,
one file per tier, one children file per parent, and `_sync-state.json`. The
last hand-made files (`class.flat.json`, `_probe/flat-array.json`) were removed
in the reset.

## 3. What breaks if the relational fields go away

Every catalog endpoint filters on them:

```
programs.json       {{each programs as p where FIND_IN_SET('{get_var.category}', p.categories) …}}
courses.json        {{each courses  as c where FIND_IN_SET('{get_var.program}',  c.programs)   …}}
classes.json        {{each classes  as cl where FIND_IN_SET(cl.courses, '{get_var.courses}')   …}}
class-finder.json   emits categoryZuid / programZuid / courseZuid per row
catalog-parents.json resolves a program by zuid
```

Remove the fields and **Parsley can no longer filter or paginate by parent**,
because it can only query Zesty's own content store.

**This matters much less than it sounds.** The whole catalog is 9 categories,
22 programs, 119 courses and 65 publishable classes — **215 items**. Parsley
can emit every program in a model unfiltered for about 2 KB. `class-finder.json`
*already* loops the entire `classes` model with no course filter, because that
was the only way to build the finder. Server-side filtering here is an
optimisation for a scale this catalog does not have.

What genuinely changes:

- **Pagination moves client-side.** `programs.json?start=&limit=` paginates the
  filtered set in Parsley today. The browser would fetch all 22 and slice.
- **One extra fetch on listing pages**, unless the hierarchy is inlined (§4).
- **Sorting by a Traction Rec value** (start date, price) leaves Parsley's
  `sort by`. It becomes a JS sort over fetched rows.

---

## 4. The proposed shape

### 4.1 Relationships: a parent id field (see §2.3f) — files only for values

`api.json.get()` reads a file *and* yields structure (§2.3), so the index needs
**no Zesty field at all**. That is the answer to the stated goal: the hierarchy
lives entirely in Traction Rec's snapshots, and Parsley still renders it server
side.

⚠️ **Read §2.3g first.** The catalog listings are already rendered by
JavaScript, so the relationship never needs to pass through Parsley. The files
below are fetched by the existing React components and **replace** five
hand-written Parsley endpoints rather than adding to them.

§2.3f's `parent_tractionrec_id` field is a viable Parsley-only fallback, but it
puts Traction Rec data in a Zesty field, which the stated direction rules out.

The files below remain relevant for **values** (what a detail page renders) and
for the class finder, which wants the whole tier in the browser anyway.

**One file per parent** — `/tractionrec/_children/<tier>/<parentTrId>.json`.

**Alternative: one file per tier**, filtered in-template. Useful for the class
finder, which wants the whole set anyway. Each a **root-level array of flat
rows**:

```
/tractionrec/_index/program_category.json   9 rows    1.2 KB
/tractionrec/_index/program.json           20 rows    3.1 KB
/tractionrec/_index/course.json           118 rows   20.3 KB
/tractionrec/_index/class.json             65 rows   11.4 KB

[ { "trId": "a31a…", "zuid": "7-…", "path": "/sports-boxing/",
    "title": "Boxing", "parent": "a2za…GGX6AAO" }, … ]
```

**Both constraints are forced by the engine, not chosen.** A root array,
because an object root loops exactly once. Flat scalar rows, because reading a
value that is itself an object **crashes the page** — which is why `parents`
flattens to a single `parent` string (harmless today: no program is tagged to
two categories) and why the index is four files rather than one object with
four keys.

A category page then renders its programs server side, with no field and no
client-side join:

```
{{each api.json.get(https://kroc.zesty.dev/tractionrec/_index/course.json) as c}}
  {{if {c.parent} == ({this.tractionrec_id})}}
    <a href="{{!c.path}}">{{!c.title}}</a>
  {{end-if}}
{{end-each}}
```

⚠️ The inner `{{if}}` is mandatory — a `where` clause is **silently ignored**
and returns every row (§2.3). ⚠️ And the comparison value must be in
**parentheses**: the quoted and bare forms match nothing, silently (§2.3b).

⚠️ The domain is hardcoded in the URL. That wants a Parsley variable or an
environment-aware value, or staging will fetch production's index.

**`path` vs `getUrl()`.** Storing `path` means the browser needs nothing else,
but Zesty owns URLs, so an editor changing one makes the index stale until the
next sync. The sync rewrites it every run, so it self-heals within a cron
cycle, and Zesty keeps the old path as a redirect rather than 404ing. That is
an acceptable trade; the alternative is joining against a Parsley-emitted
`{zuid, tractionrec_id, url}` list, which is always correct and costs a second
fetch.

### 4.2 Detail pages inline their own snapshot

Because `{this.*}` interpolates, a class page keeps **server-rendered** TR data
with no field and no fetch:

```
<script type="application/json" id="kroc-tr-class">
{{ include /tractionrec/classes/{this.tractionrec_id}.json }}
</script>
```

The block reads that inert JSON on mount. This is the part that surprised me —
it means moving TR data out of Zesty fields does **not** cost server-side
rendering on the pages that matter most for SEO. The detail page's meta title,
meta description and canonical URL stay Zesty fields, exactly as the direction
requires.

Guard for empty: a snapshot that has not synced yet inlines nothing, and
`JSON.parse("")` throws. Wrap it.

### 4.3 Listings render server side from the index files

Because §4.1 fetches the index by URL, a listing is ordinary server-side
Parsley — no field, no client fetch, and the links are in the HTML a crawler
sees. Every worry about SEO regression in earlier drafts of this document is
resolved by `api.json.get()`.

The client-side path stays available where it is genuinely better: the class
finder filters and sorts across the whole catalog as the user types, which
wants the JSON in the browser, not a server round trip per keystroke.

**Watch the fetch count.** Each `api.json.get()` is an HTTP call made while the
page renders. One is cheap (~0.7 s page, §2.3). A page that fetches an index
*and* a snapshot per row would be doing dozens, serially, with failures that
render as silently-empty. Fetch whole arrays and filter in the template, rather
than fetching per row.

## 5. Consequences worth accepting deliberately

**Listing content stays server-rendered.** This was the main worry before
`json()` was tested, and it turns out not to apply: §4.3 renders listings from
the index field in Parsley, so the links are in the HTML. Detail pages keep
theirs via `include` (§4.2). Nothing about this proposal makes the site less
crawlable than it is today.

**Zesty search stops finding Traction Rec content.** `findItem` searches item
fields. Once class times and prices are not fields, the Manager's search will
not match them. Editors search for a class by *name*, which stays a field, so
this is probably acceptable — but it should be a conscious trade, not a
surprise.

**Two sources of truth for "what is a class" collapse into one.** That is the
point, and it is the main benefit. Today `[classes]` carries
`spots_remaining`, `member_price`, `enrollment_status` and `deep_link_url` as
fields *and* the snapshot carries them. Whichever the template reads, the other
is a lie waiting to be noticed.

**Re-parenting starts working.** A field written once at create never follows a
change in Traction Rec. An index rewritten every run does. This removes a drift
case that currently has no detection at all.

---

## 6. Migration order

Nothing here needs doing at once, and each step is independently useful.

1. **Change the snapshot format to a flat root array** (§2.3d) and add the
   per-parent `_children` files. Both are additive to the running system —
   nothing reads them yet and the relational fields keep working — but the
   snapshot change is a **breaking change for anything already parsing the
   nested shape**, so do it before writing consumers, not after.
2. **Move one listing to the index** — `programs.json` on the category page is
   the smallest. Verify the rendering and the crawler behaviour against the
   existing field-driven version running beside it.
3. **Move the remaining listings**, then `class-finder.json`, which is the one
   with real filter logic.
4. **Stop writing the relational fields** on create, and remove them from the
   models. This is the irreversible step; do it only once every reader is off
   them.
5. **Then repeat the exercise for the value fields** — `class_start_date`,
   `time`, `age_range`, `member_price`, `public_price`, `spots_remaining`,
   `enrollment_status`, `deep_link_url`, `instructors`, `description` on
   `[classes]`, and `description` on `[courses]`. §4.2 already covers how a
   detail page reads them. Keep `class_name`, the hero image, the meta fields
   and the URL — Zesty genuinely owns those.

Step 4 is where the CMS stops lying to editors, which is the actual goal.

---

## 7. Open questions

- **Do `include` path interpolation and `json()` work inside a block view**,
  where `this` is the block item rather than the page? Blocks are where most
  rendering happens, and both were probed on a templateset. The same probe
  pattern answers it in ten minutes.
- **Can a `json()` loop reach an index item on a different model** —
  `{{each {tractionrec_index.programs}.json() as p}}` as written in §4.1 —
  or does it need the dataset-loop form used for multi-item
  models? Tested only as `{this.field}` on the page's own item.
- **Is an included view counted against any render budget?** A page inlining
  one snapshot is fine. A listing page inlining 65 would matter — but it cannot
  do that anyway, since loop aliases do not interpolate.
- **Does the index file need cache headers?** It changes every sync. If the
  browser caches it for an hour, a new class is invisible for an hour, which
  interacts with the freshness trade-off in
  [sync-flow.md §6](sync-flow.md#6-the-freshness-tradeoff--read-this-before-scheduling).
- **Should the snapshot stop carrying `zestyItemZuid`** once the index exists?
  It would be the second place the mapping lives.
