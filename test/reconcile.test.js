"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { reconcile, orphansAreMeaningful } = require("../src/sync/reconcile");
const { TIERS, TR_ID_FIELD } = require("../src/config");
const { buildSnapshot } = require("../src/sync/shape");

const tier = TIERS.program_category;

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

const zestyItem = (zuid, trId, name) => ({
  meta: { ZUID: zuid },
  data: { [TR_ID_FIELD]: trId, category_name: name },
  web: { metaTitle: name }
});

const emptyIndex = () => ({ byTrId: new Map(), duplicates: new Map(), unlinked: [] });

test("a Traction Rec record with no Zesty item is queued for creation", () => {
  const plan = reconcile({
    tierKey: "program_category",
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
    tierKey: "program_category",
    tier,
    trRecords: [trRecord("a0A1", "Arts & Culture")],
    itemIndex: emptyIndex()
  });
  assert.equal(plan.create[0].pathPart, "arts-and-culture");
});

test("an unchanged record produces no write at all", () => {
  const record = trRecord("a0A1", "Aquatics");
  const now = new Date("2026-09-25T00:00:00Z");
  const snapshot = buildSnapshot({ tierKey: "program_category", tier, record, extras: {}, now });

  const index = emptyIndex();
  index.byTrId.set("a0A1", zestyItem("7-abc", "a0A1", "Aquatics"));

  const plan = reconcile({
    tierKey: "program_category",
    tier,
    trRecords: [record],
    itemIndex: index,
    previousHashes: { a0A1: snapshot.meta.hash },
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
    tierKey: "program_category",
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
    tierKey: "program_category",
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
    tierKey: "program_category",
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
    tierKey: "program_category",
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
  const programTier = TIERS.program;
  const extras = { parentByChild: new Map([["a0P1", ["a0C1"]]]) };

  const plan = reconcile({
    tierKey: "program",
    tier: programTier,
    trRecords: [{ Id: "a0P1", Name: "Swim Lessons", SystemModstamp: "x" }],
    extras,
    itemIndex: emptyIndex()
  });

  assert.deepEqual(plan.create[0].parentTrIds, ["a0C1"]);
});

test("orphans are only meaningful for a tier fetched in full", () => {
  assert.equal(orphansAreMeaningful(TIERS.program_category), true);
  // The class tier filters on Traction Rec's publishing gate, so a class that
  // merely closed for the season is not a deletion.
  assert.equal(orphansAreMeaningful(TIERS.class), false);
});
