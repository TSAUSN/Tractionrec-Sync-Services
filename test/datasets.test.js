"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { convert } = require("../src/datasets/values");
const { DATASETS, byKey } = require("../src/datasets/definitions");
const { loadSpecs, checkDefinitions } = require("../src/datasets/schema");
const { planDataset, dataHash } = require("../src/datasets/plan");
const { datasetTier, uniqueById } = require("../src/datasets/fetch");
const { TIERS } = require("../src/config");

const specs = loadSpecs();
const typesFor = (key) => new Map(specs.get(key).fields.map((f) => [f.name, f.datatype]));
const emptyIndex = () => ({ byTrId: new Map(), duplicates: new Map(), unlinked: [] });
const NOW = new Date("2026-10-19T12:00:00Z");

// --- values -----------------------------------------------------------------

test("text stops at 150 characters, counted as characters", () => {
  assert.deepEqual(convert("text", "abc"), { value: "abc", warning: null });
  const long = convert("text", "é".repeat(151));
  assert.equal([...long.value].length, 150);
  assert.match(long.warning, /151 to 150/);
  assert.equal(convert("text", "é".repeat(150)).warning, null);
});

test("empty values are null, never an empty string", () => {
  for (const t of ["text", "textarea", "number", "currency", "date", "datetime", "link", "one_to_one"]) {
    assert.equal(convert(t, "").value, null, t);
    assert.equal(convert(t, null).value, null, t);
    assert.equal(convert(t, undefined).value, null, t);
  }
  assert.equal(convert("one_to_many", []).value, null);
});

test("numbers keep 0 and decimals; text in a number field is dropped with a warning", () => {
  assert.equal(convert("number", 0).value, 0);
  assert.equal(convert("number", 12.5).value, 12.5);
  assert.deepEqual(convert("number", "abc"), { value: null, warning: 'not a number: "abc"' });
  assert.equal(convert("currency", 15.5).value, "15.5");
  assert.equal(convert("currency", 0).value, "0");
});

test("yes_no is always 0 or 1, because an omitted one is stored as 0 anyway", () => {
  assert.equal(convert("yes_no", true).value, 1);
  assert.equal(convert("yes_no", false).value, 0);
  assert.equal(convert("yes_no", null).value, 0);
});

test("Salesforce dates and datetimes become Zesty's shapes, in UTC", () => {
  assert.equal(convert("datetime", "2025-02-20T22:12:35.000+0000").value, "2025-02-20 22:12:35");
  assert.equal(convert("datetime", "2025-02-20T22:12:35.000-0700").value, "2025-02-21 05:12:35");
  assert.equal(convert("date", "2026-10-05").value, "2026-10-05");
  assert.equal(convert("date", "2026-10-05T00:00:00.000+0000").value, "2026-10-05");
  assert.equal(convert("date", "soon").value, null);
});

test("one_to_many joins ZUIDs with commas", () => {
  assert.equal(convert("one_to_many", ["7-a", "7-b"]).value, "7-a,7-b");
});

test("an unknown datatype is an error, not a silent pass-through", () => {
  assert.throws(() => convert("repeater", []), /No conversion/);
});

// --- definitions <-> specs ----------------------------------------------------

test("every definition matches its zesty-models spec, both ways", () => {
  assert.deepEqual(checkDefinitions(specs), []);
});

test("datasets come after every dataset they relate to", () => {
  const order = DATASETS.map((d) => d.key);
  for (const ds of DATASETS) {
    for (const rel of Object.values(ds.relations)) {
      if (rel.dataset) {
        assert.ok(order.indexOf(rel.dataset) < order.indexOf(ds.key), `${ds.key} -> ${rel.dataset}`);
      }
    }
  }
});

// --- fetch ----------------------------------------------------------------------

test("datasetTier adds modstamps to the price queries without changing the file sync's tiers", () => {
  const before = JSON.stringify(TIERS.membership_types.priceJoin);
  const tier = datasetTier(TIERS.membership_types);
  assert.ok(tier.priceJoin.fields.includes("SystemModstamp"));
  assert.ok(tier.priceJoin.schedules.fields.includes("LastModifiedDate"));
  assert.equal(JSON.stringify(TIERS.membership_types.priceJoin), before);
  assert.equal(datasetTier(TIERS.courses), TIERS.courses);
});

test("a price level shared by several classes is one record", () => {
  assert.deepEqual(uniqueById([{ Id: "a" }, { Id: "b" }, { Id: "a" }, null]).map((r) => r.Id), ["a", "b"]);
});

// --- plan -------------------------------------------------------------------------

const course = {
  Id: "a1z1",
  Name: "Kids Boxing",
  TREX1__Program__c: "a311",
  TREX1__Available__c: true,
  TREX1__Available_Online__c: true,
  TREX1__Description__c: null,
  TREX1__Rich_Description__c: "<p>Hi</p>",
  LastModifiedDate: "2026-08-03T23:11:10.000+0000",
  SystemModstamp: "2026-08-03T23:11:10.000+0000"
};

function planCourses({ records = [course], items = emptyIndex(), programs = new Map([["a311", "7-prog"]]), inactive = new Map() } = {}) {
  return planDataset({
    ds: byKey("tr_courses"),
    records,
    inactive,
    tr: {},
    types: typesFor("tr_courses"),
    items,
    zuids: new Map([["tr_programs", programs]]),
    pages: new Map([["courses", new Map([["a1z1", "7-page"]])]]),
    now: NOW
  });
}

test("a new record is planned as a create, with relations as ZUIDs and values converted", () => {
  const plan = planCourses();
  assert.equal(plan.create.length, 1);
  const { data } = plan.create[0];
  assert.equal(data.tractionrec_id, "a1z1");
  assert.equal(data.program, "7-prog");
  assert.equal(data.page, "7-page");
  assert.equal(data.available, 1);
  assert.equal(data.description, null);
  assert.equal(data.last_modified_date, "2026-08-03 23:11:10");
  assert.equal(data.synced_at, "2026-10-19 12:00:00");
  assert.match(data.sync_hash, /^sha256:/);
});

test("an item with the same hash is unchanged; a different one is an update", () => {
  const { data } = planCourses().create[0];
  const item = { meta: { ZUID: "7-course" }, data: { ...data } };
  const items = { byTrId: new Map([["a1z1", item]]), duplicates: new Map(), unlinked: [] };
  assert.equal(planCourses({ items }).unchanged.length, 1);

  const renamed = { ...course, Name: "Kids Boxing 2" };
  const plan = planCourses({ records: [renamed], items });
  assert.equal(plan.update.length, 1);
  assert.equal(plan.update[0].zuid, "7-course");
});

test("synced_at is outside the hash, so a later run alone changes nothing", () => {
  const a = planCourses().create[0].data;
  const b = { ...a, synced_at: "2030-01-01 00:00:00" };
  assert.equal(dataHash(a), dataHash(b));
});

test("a re-created parent changes the child's hash, so the child is rewritten", () => {
  const a = planCourses().create[0].data.sync_hash;
  const b = planCourses({ programs: new Map([["a311", "7-new"]]) }).create[0].data.sync_hash;
  assert.notEqual(a, b);
});

test("a published record whose required parent can't be resolved is written inactive, with the reason", () => {
  const plan = planCourses({ programs: new Map() });
  assert.equal(plan.create.length, 1);
  const { data } = plan.create[0];
  assert.equal(data.active, 0);
  assert.equal(data.inactive_reason, "Its program (a311) is not in tr_programs");
  assert.equal(data.program, null);
  assert.deepEqual(plan.deactivated.map((d) => d.trId), ["a1z1"]);
});

test("an optional relation that does not resolve is left empty with a warning", () => {
  const cls = {
    Id: "a1u1",
    TREX1__cso_Course_Session__r: { TREX1__Course__c: "a1z1" },
    TREX1__Course_Option__r: { Name: "Boxing Fall", TREX1__Product__c: "a2x1", TREX1__Unlimited_Capacity__c: false }
  };
  const plan = planDataset({
    ds: byKey("tr_classes"),
    records: [cls],
    tr: {},
    types: typesFor("tr_classes"),
    items: emptyIndex(),
    zuids: new Map([["tr_courses", new Map([["a1z1", "7-course"]])], ["tr_products", new Map()]]),
    pages: new Map(),
    now: NOW
  });
  const { data } = plan.create[0];
  assert.equal(data.name, "Boxing Fall");
  assert.equal(data.course, "7-course");
  assert.equal(data.product, null);
  assert.equal(data.page, null);
  assert.deepEqual(plan.warnings.map((w) => w.field), ["product"]);
});

test("program categories come from the junction and are written as a one_to_many", () => {
  const program = { Id: "a311", Name: "Boxing" };
  const tr = { programs: { extras: { parentByChild: new Map([["a311", ["a2z1", "a2z2"]]]) } } };
  const plan = planDataset({
    ds: byKey("tr_programs"),
    records: [program],
    tr,
    types: typesFor("tr_programs"),
    items: emptyIndex(),
    zuids: new Map([["tr_program_categories", new Map([["a2z1", "7-c1"], ["a2z2", "7-c2"]])]]),
    pages: new Map(),
    now: NOW
  });
  assert.equal(plan.create[0].data.program_categories, "7-c1,7-c2");

  const untagged = planDataset({
    ds: byKey("tr_programs"),
    records: [{ Id: "a312", Name: "Kickball" }],
    tr,
    types: typesFor("tr_programs"),
    items: emptyIndex(),
    zuids: new Map([["tr_program_categories", new Map()]]),
    pages: new Map(),
    now: NOW
  });
  assert.equal(untagged.create[0].data.active, 0);
  assert.equal(untagged.create[0].data.inactive_reason, "No program_categories in Traction Rec");
});

// --- lifecycle: nothing is deleted, rows become inactive ----------

const itemsOf = (data, zuid = "7-course") => ({
  byTrId: new Map([[data.tractionrec_id, { meta: { ZUID: zuid }, data: { ...data } }]]),
  duplicates: new Map(),
  unlinked: []
});
const publishedCourse = () => planCourses().create[0].data;

test("a record removed from Traction Rec keeps its data and becomes inactive", () => {
  const items = itemsOf(publishedCourse());
  const plan = planCourses({ records: [], items, inactive: new Map([["a1z1", null]]) });
  assert.equal(plan.update.length, 1);
  const { data } = plan.update[0];
  assert.equal(data.active, 0);
  assert.equal(data.inactive_reason, "Removed from Traction Rec");
  assert.equal(data.name, "Kids Boxing");
  assert.equal(data.program, "7-prog");
  assert.deepEqual(plan.deactivated, [{ trId: "a1z1", name: "Kids Boxing", reason: "Removed from Traction Rec" }]);
});

test("an inactive row is stable: the next run writes nothing", () => {
  const first = planCourses({ records: [], items: itemsOf(publishedCourse()), inactive: new Map([["a1z1", null]]) });
  const again = planCourses({ records: [], items: itemsOf(first.update[0].data), inactive: new Map([["a1z1", null]]) });
  assert.equal(again.update.length, 0);
  assert.equal(again.unchanged.length, 1);
  assert.equal(again.deactivated.length, 0);
});

test("a class outside the published set takes Traction Rec's own reason and current values", () => {
  const cls = {
    Id: "a1u9",
    TREX1__Course_Online_Availability__c: "Outside Course Option Registration Timeframe |",
    TREX1__cso_Course_Session__r: { TREX1__Course__c: "a1z1" },
    TREX1__Course_Option__r: { Name: "Boxing Oct", TREX1__Total_Capacity_Available__c: 3 }
  };
  const plan = planDataset({
    ds: byKey("tr_classes"),
    records: [],
    inactive: new Map([["a1u9", cls]]),
    tr: {},
    types: typesFor("tr_classes"),
    items: emptyIndex(),
    zuids: new Map([["tr_courses", new Map([["a1z1", "7-course"]])], ["tr_products", new Map()]]),
    pages: new Map([["classes", new Map([["a1u9", "7-old-page"]])]]),
    now: NOW
  });
  // a page item with no row yet (the old class pages): backfilled as inactive
  assert.equal(plan.create.length, 1);
  const { data } = plan.create[0];
  assert.equal(data.active, 0);
  assert.equal(data.inactive_reason, "Outside Course Option Registration Timeframe");
  assert.equal(data.name, "Boxing Oct");
  assert.equal(data.capacity_available, 3);
  assert.equal(data.page, "7-old-page");
});

test("a record that comes back is reactivated", () => {
  const off = planCourses({ records: [], items: itemsOf(publishedCourse()), inactive: new Map([["a1z1", null]]) });
  const plan = planCourses({ items: itemsOf(off.update[0].data) });
  assert.equal(plan.update.length, 1);
  assert.equal(plan.update[0].data.active, 1);
  assert.equal(plan.update[0].data.inactive_reason, null);
  assert.deepEqual(plan.reactivated, [{ trId: "a1z1", name: "Kids Boxing" }]);
});

test("a derived row (product, price level, schedule) no longer used is inactive, not 'removed'", () => {
  const level = { Id: "a2r1", Name: "Member", TREX1__Product__c: "a2x1", TREX1__Total_Billing_Schedule_Amount__c: 80 };
  const types = typesFor("tr_price_levels");
  const base = (records, items, inactive) =>
    planDataset({ ds: byKey("tr_price_levels"), records, inactive, tr: {}, types, items, zuids: new Map([["tr_products", new Map([["a2x1", "7-prod"]])]]), pages: new Map(), now: NOW });
  const made = base([level], emptyIndex(), new Map()).create[0].data;
  const plan = base([], itemsOf(made, "7-level"), new Map([["a2r1", null]]));
  assert.equal(plan.update[0].data.active, 0);
  assert.equal(plan.update[0].data.inactive_reason, "No longer used by a published class or membership type");
});

test("a page item whose record no longer exists anywhere is reported, not invented", () => {
  const plan = planCourses({ records: [], inactive: new Map([["a1zGONE", null]]) });
  assert.equal(plan.create.length + plan.update.length, 0);
  assert.deepEqual(plan.unresolved, [{ trId: "a1zGONE", reason: "Page item's record is not in Traction Rec" }]);
});

test("a rename is flagged for the page; other changes are not", () => {
  const items = itemsOf(publishedCourse());
  assert.equal(planCourses({ records: [{ ...course, Name: "Kids Boxing 2" }], items }).update[0].renamed, true);
  assert.equal(planCourses({ records: [{ ...course, TREX1__Description__c: "New copy" }], items }).update[0].renamed, false);
});

test("an item written before the active field existed is not reported as reactivated", () => {
  const legacy = { ...publishedCourse(), active: null, sync_hash: "old" };
  const plan = planCourses({ items: itemsOf(legacy) });
  assert.equal(plan.update.length, 1);
  assert.equal(plan.reactivated.length, 0);
  assert.equal(plan.deactivated.length, 0);
});

// --- pages ---------------------------------------------------------------------

const { createMissingPages, parentPageOf } = require("../src/datasets/pages");

test("a class page is created at the root, its slug told apart by its course's, with a title and nothing else", async () => {
  const cls = {
    Id: "a1uN",
    TREX1__cso_Course_Session__r: { TREX1__Course__c: "a1z1" },
    TREX1__Course_Option__r: { Name: "Boxing" }
  };
  const pageItems = new Map([
    ["courses", new Map([["a1z1", { meta: { ZUID: "7-coursepage" }, web: { pathPart: "kids-boxing" } }]])],
    ["classes", new Map()]
  ]);
  const used = new Set(["boxing"]);
  const { created } = await createMissingPages({ zesty: null, ds: byKey("tr_classes"), records: [cls], tr: {}, models: new Map(), pageItems, usedPaths: used, dryRun: true });
  assert.equal(created.length, 1);
  assert.equal(created[0].pathPart, "kids-boxing-boxing");
  const page = pageItems.get("classes").get("a1uN");
  assert.deepEqual(page.data, { tractionrec_id: "a1uN", class_name: "Boxing" });
  assert.deepEqual(page.web, { pathPart: "kids-boxing-boxing", metaTitle: "Boxing", metaLinkText: "Boxing" });
});

test("no page is created for a record whose parent has no page", async () => {
  const program = { Id: "a31K", Name: "Kickball" };
  const pageItems = new Map([["categories", new Map()], ["programs", new Map()]]);
  const tr = { programs: { extras: { parentByChild: new Map() } } };
  assert.equal(parentPageOf(byKey("tr_programs"), program, tr, pageItems), null);
  const { created } = await createMissingPages({ zesty: null, ds: byKey("tr_programs"), records: [program], tr, models: new Map(), pageItems, usedPaths: new Set(), dryRun: true });
  assert.equal(created.length, 0);
});
