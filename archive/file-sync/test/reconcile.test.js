"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { reconcile, orphansAreMeaningful } = require("../src/sync/reconcile");
const { TIERS, TR_ID_FIELD } = require("../src/config");
const { buildSnapshot, linkItem, fileKey } = require("../src/sync/shape");

const tier = TIERS.program_categories;

const trRecord = (id, name, extra = {}) => ({
  Id: id,
  Name: name,
  TREX1__Available__c: true,
  TREX1__Available_Online__c: true,
  TREX1__Description_Rich_Text__c: null,
  LastModifiedDate: "2026-09-01T00:00:00.000+0000",
  SystemModstamp: "2026-09-01T00:00:00.000+0000",
  ...extra
});

const zestyItem = (zuid, trId, name, path = "/aquatics/") => ({
  meta: { ZUID: zuid },
  data: { [TR_ID_FIELD]: trId, category_name: name },
  web: { metaTitle: name, path }
});

// What the ledger holds for a record file written against the item above.
const ledgerKey = (snapshot, zuid = "7-abc", path = "/aquatics/") =>
  fileKey(linkItem(snapshot, { zuid, path }));

const emptyIndex = () => ({ byTrId: new Map(), duplicates: new Map(), unlinked: [] });

test("a Traction Rec record with no Zesty item is queued for creation", () => {
  const plan = reconcile({
    tierKey: "program_categories",
    tier,
    trRecords: [trRecord("a0A1", "Aquatics")],
    itemIndex: emptyIndex()
  });

  assert.equal(plan.create.length, 1);
  assert.equal(plan.create[0].trId, "a0A1");
  assert.equal(plan.create[0].pathPart, "aquatics");
  assert.equal(plan.orphans.length, 0);
});

test("a slug is derived from the name, including ampersands", () => {
  const plan = reconcile({
    tierKey: "program_categories",
    tier,
    trRecords: [trRecord("a0A1", "Arts & Culture")],
    itemIndex: emptyIndex()
  });
  assert.equal(plan.create[0].pathPart, "arts-and-culture");
});

test("an unchanged record produces no write at all", () => {
  const record = trRecord("a0A1", "Aquatics");
  const now = new Date("2026-09-25T00:00:00Z");
  const snapshot = buildSnapshot({ tierKey: "program_categories", tier, record, extras: {}, now });

  const index = emptyIndex();
  index.byTrId.set("a0A1", zestyItem("7-abc", "a0A1", "Aquatics"));

  const plan = reconcile({
    tierKey: "program_categories",
    tier,
    trRecords: [record],
    itemIndex: index,
    previousHashes: { a0A1: ledgerKey(snapshot) },
    // A later run: the timestamp moves, the data does not.
    now: new Date("2026-09-25T06:00:00Z")
  });

  assert.equal(plan.unchanged.length, 1, "syncedAt must not be part of the hash");
  assert.equal(plan.refresh.length, 0);
  assert.equal(plan.create.length, 0);
});

test("a changed field marks the snapshot for refresh, not the item for update", () => {
  const index = emptyIndex();
  index.byTrId.set("a0A1", zestyItem("7-abc", "a0A1", "Aquatics"));

  const plan = reconcile({
    tierKey: "program_categories",
    tier,
    trRecords: [trRecord("a0A1", "Aquatics", { TREX1__Available_Online__c: false })],
    itemIndex: index,
    previousHashes: { a0A1: "sha256:stale" }
  });

  assert.equal(plan.refresh.length, 1);
  assert.equal(plan.refresh[0].zuid, "7-abc");
  // There is no "update item" bucket, by design — see reconcile.js.
  assert.ok(!("updateItem" in plan));
});

test("a Zesty item whose Traction Rec record is gone is reported, never deleted", () => {
  const index = emptyIndex();
  index.byTrId.set("a0GONE", zestyItem("7-old", "a0GONE", "Retired Category"));

  const plan = reconcile({
    tierKey: "program_categories",
    tier,
    trRecords: [],
    itemIndex: index
  });

  assert.equal(plan.orphans.length, 1);
  assert.deepEqual(plan.orphans[0], {
    trId: "a0GONE",
    zuid: "7-old",
    title: "Retired Category"
  });
  assert.ok(!("delete" in plan), "the plan has no delete bucket");
});

test("a hand-authored Zesty item with no Traction Rec id is left alone", () => {
  const index = emptyIndex();
  index.unlinked.push({
    meta: { ZUID: "7-hand" },
    data: { category_name: "Editor's Picks" },
    web: {}
  });

  const plan = reconcile({
    tierKey: "program_categories",
    tier,
    trRecords: [],
    itemIndex: index
  });

  assert.equal(plan.unlinked.length, 1);
  assert.equal(plan.orphans.length, 0);
  assert.equal(plan.refresh.length, 0);
});

test("two items claiming the same Traction Rec id are a conflict, and nothing is written", () => {
  const index = emptyIndex();
  index.duplicates.set("a0A1", [zestyItem("7-one", "a0A1", "Aquatics"), zestyItem("7-two", "a0A1", "Aquatics")]);

  const plan = reconcile({
    tierKey: "program_categories",
    tier,
    trRecords: [trRecord("a0A1", "Aquatics")],
    itemIndex: index
  });

  assert.equal(plan.conflicts.length, 1);
  assert.deepEqual(plan.conflicts[0].zuids, ["7-one", "7-two"]);
  assert.equal(plan.create.length, 0);
  assert.equal(plan.refresh.length, 0);
});

test("the category junction supplies a program's parent ids", () => {
  const programTier = TIERS.programs;
  const extras = { parentByChild: new Map([["a0P1", ["a0C1"]]]) };

  const plan = reconcile({
    tierKey: "programs",
    tier: programTier,
    trRecords: [{ Id: "a0P1", Name: "Swim Lessons", SystemModstamp: "x" }],
    extras,
    itemIndex: emptyIndex()
  });

  assert.deepEqual(plan.create[0].parentTrIds, ["a0C1"]);
});

test("orphans are only meaningful for a tier fetched in full", () => {
  assert.equal(orphansAreMeaningful(TIERS.program_categories), true);
  // The class tier filters on Traction Rec's publishing gate, so a class that
  // merely closed for the season is not a deletion.
  assert.equal(orphansAreMeaningful(TIERS.classes), false);
});

test("the record is published with Salesforce's own field names, untouched", () => {
  const snap = buildSnapshot({
    tierKey: "courses",
    tier: TIERS.courses,
    record: {
      attributes: { type: "TREX1__Course__c", url: "/services/data/v62.0/…" },
      Id: "a1za1",
      Name: "Kids Boxing",
      TREX1__Program__c: "a31a1",
      SystemModstamp: "x"
    },
    extras: {}
  });

  assert.equal(snap.TREX1__Program__c, "a31a1", "no renaming");
  assert.equal(snap.Name, "Kids Boxing");
  assert.ok(!("attributes" in snap), "only the API envelope is stripped");
});

test("nested __r objects keep Traction Rec's own structure", () => {
  const snap = buildSnapshot({
    tierKey: "classes",
    tier: TIERS.classes,
    record: {
      attributes: { type: "x" },
      Id: "a1ua1",
      TREX1__Course_Option__r: {
        attributes: { type: "y" },
        Name: "Swim Level 2",
        TREX1__Age_Min__c: 5
      },
      SystemModstamp: "x"
    },
    extras: {}
  });

  assert.equal(snap.TREX1__Course_Option__r.Name, "Swim Level 2");
  assert.equal(snap.TREX1__Course_Option__r.TREX1__Age_Min__c, 5);
  assert.ok(!("attributes" in snap.TREX1__Course_Option__r), "stripped at every depth");
});

test("only Program gets an added relation key, named after the junction field", () => {
  // Course and Class already carry their parent in the record Salesforce
  // returns, so nothing is added to them.
  assert.equal(TIERS.programs.relationKey, "TREX1__Program_Category__c");
  assert.equal(TIERS.courses.relationKey, undefined);
  assert.equal(TIERS.classes.relationKey, undefined);
  assert.equal(TIERS.program_categories.relationKey, undefined);

  const prog = buildSnapshot({
    tierKey: "programs",
    tier: TIERS.programs,
    record: { Id: "a0P1", Name: "Swim Lessons", SystemModstamp: "x" },
    extras: { parentByChild: new Map([["a0P1", ["a0C1", "a0C2"]]]) }
  });
  assert.deepEqual(prog.TREX1__Program_Category__c, ["a0C1", "a0C2"], "many-to-many kept");

  const course = buildSnapshot({
    tierKey: "courses",
    tier: TIERS.courses,
    record: { Id: "a1za1", TREX1__Program__c: "a31a1", SystemModstamp: "x" },
    extras: {}
  });
  assert.deepEqual(Object.keys(course), ["Id", "TREX1__Program__c", "SystemModstamp", "meta"], "nothing added to a course");
});

test("Salesforce fields sit at the root, where Parsley's api.json.get can read them", () => {
  // api.json.get binds a row one level deep: {{r.Name}} renders, while
  // {{r.data.Name}} crashes the page. So no envelope may sit between the file
  // root and Traction Rec's fields. Only the sync's own bookkeeping nests.
  const snap = buildSnapshot({
    tierKey: "courses",
    tier: TIERS.courses,
    record: { Id: "a1za1", Name: "Kids Boxing", TREX1__Program__c: "a31a1", SystemModstamp: "x" },
    extras: {}
  });
  assert.equal(snap.data, undefined, "no data envelope");
  for (const [key, value] of Object.entries(snap)) {
    if (key !== "meta") {
      assert.notEqual(typeof value, "object", `${key} is a root scalar`);
    }
  }
  assert.equal(snap.meta.tractionrecId, "a1za1");
});

test("the hash ignores meta, so an unchanged record hashes the same on every run", () => {
  const record = { Id: "a1za1", Name: "Kids Boxing", SystemModstamp: "x" };
  const a = buildSnapshot({ tierKey: "courses", tier: TIERS.courses, record, extras: {}, now: new Date(1) });
  const b = buildSnapshot({ tierKey: "courses", tier: TIERS.courses, record, extras: {}, now: new Date(2) });
  assert.notEqual(a.meta.syncedAt, b.meta.syncedAt);
  assert.equal(a.meta.hash, b.meta.hash);
});

test("a Salesforce field that clashes with a key the sync adds fails loudly", () => {
  assert.throws(
    () =>
      buildSnapshot({
        tierKey: "programs",
        tier: TIERS.programs,
        record: { Id: "a0P1", TREX1__Program_Category__c: "a0C9", SystemModstamp: "x" },
        extras: { parentByChild: new Map() }
      }),
    /collides/
  );
});

test("every record's snapshot is returned, so a tier file can include unchanged rows", () => {
  const record = trRecord("a0A1", "Aquatics");
  const now = new Date("2026-09-25T00:00:00Z");
  const built = buildSnapshot({ tierKey: "program_categories", tier, record, extras: {}, now });

  const index = emptyIndex();
  index.byTrId.set("a0A1", zestyItem("7-abc", "a0A1", "Aquatics"));

  const plan = reconcile({
    tierKey: "program_categories",
    tier,
    trRecords: [record],
    itemIndex: index,
    previousHashes: { a0A1: ledgerKey(built) },
    now
  });

  assert.equal(plan.unchanged.length, 1, "nothing to write");
  assert.ok(plan.snapshotsByTrId.a0A1, "but the snapshot is still available");
  assert.equal(plan.snapshotsByTrId.a0A1.Name, "Aquatics");
});

test("existing records are linked to their Zesty item and URL", () => {
  const index = emptyIndex();
  index.byTrId.set("a0A1", zestyItem("7-abc", "a0A1", "Aquatics", "/aquatics-2/"));
  const plan = reconcile({
    tierKey: "program_categories",
    tier,
    trRecords: [trRecord("a0A1", "Aquatics")],
    itemIndex: index,
    previousHashes: {}
  });
  const meta = plan.refresh[0].snapshot.meta;
  assert.equal(meta.zestyItemZuid, "7-abc");
  assert.equal(meta.zestyPath, "/aquatics-2/", "pages link cards with this");
});

test("a URL changed in the Manager rewrites the file even when the record did not change", () => {
  const record = trRecord("a0A1", "Aquatics");
  const now = new Date("2026-09-25T00:00:00Z");
  const before = buildSnapshot({ tierKey: "program_categories", tier, record, extras: {}, now });
  const index = emptyIndex();
  index.byTrId.set("a0A1", zestyItem("7-abc", "a0A1", "Aquatics", "/swim/"));
  const plan = reconcile({
    tierKey: "program_categories",
    tier,
    trRecords: [record],
    itemIndex: index,
    previousHashes: { a0A1: ledgerKey(before, "7-abc", "/aquatics/") },
    now
  });
  assert.equal(plan.refresh.length, 1);
  assert.equal(plan.refresh[0].snapshot.meta.zestyPath, "/swim/");
});
