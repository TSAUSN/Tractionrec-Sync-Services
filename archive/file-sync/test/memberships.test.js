"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { reconcile } = require("../src/sync/reconcile");
const { TIERS } = require("../src/config");
const { buildSnapshot, fileKey } = require("../src/sync/shape");
const { buildChildrenFiles, relations } = require("../src/sync/children-files");

const tier = TIERS.membership_types;
const emptyIndex = () => ({ byTrId: new Map(), duplicates: new Map(), unlinked: [] });

const autopay = {
  attributes: { type: "TREX1__Membership_Type__c" },
  Id: "a2ma1",
  Name: "Adult Membership - Autopay",
  TREX1__Category__c: "a2la1",
  TREX1__Product__c: "a2xa1",
  TREX1__Product__r: { attributes: { type: "TREX1__Product__c" }, TREX1__Price_Description__c: "$46.00 a Month" },
  SystemModstamp: "2026-10-01T00:00:00.000+0000"
};

const extras = {
  priceLevelsByProduct: new Map([
    ["a2xa1", [{ Id: "a2ra1", Name: "Adult", TREX1__Product__c: "a2xa1", TREX1__Total_Billing_Schedule_Amount__c: 552, TREX1__Initial_Fee_Amount__c: null, TREX1__Price_Type__c: null }]]
  ]),
  schedulesByLevel: new Map([
    ["a2ra1", [{ Id: "a2qa1", Name: "Adult Membership", TREX1__Price_Level__c: "a2ra1", TREX1__Term_Type__c: "Monthly", TREX1__Amount__c: 46, TREX1__Total_Billing_Amount__c: 552, TREX1__Number_Of_Terms__c: null }]]
  ])
};

test("membership tiers are files only: no Zesty model", () => {
  assert.equal(TIERS.membership_categories.filesOnly, true);
  assert.equal(TIERS.membership_types.filesOnly, true);
  assert.equal(TIERS.membership_types.zestyModel, undefined);
});

test("a files-only record is written as a file, never queued as an item", () => {
  const plan = reconcile({ tierKey: "membership_types", tier, trRecords: [autopay], extras, itemIndex: emptyIndex() });
  assert.equal(plan.create.length, 0);
  assert.equal(plan.refresh.length, 1);
  assert.equal(plan.refresh[0].zuid, null);
  assert.equal(plan.refresh[0].snapshot.meta.zestyItemZuid, undefined, "no item to link");
});

test("a files-only record whose file is current writes nothing", () => {
  const snap = buildSnapshot({ tierKey: "membership_types", tier, record: autopay, extras });
  const plan = reconcile({
    tierKey: "membership_types",
    tier,
    trRecords: [autopay],
    extras,
    itemIndex: emptyIndex(),
    previousHashes: { a2ma1: fileKey(snap) }
  });
  assert.equal(plan.refresh.length, 0);
  assert.equal(plan.unchanged.length, 1);
});

test("membership prices carry the billing schedules; the monthly amount lives there", () => {
  const snap = buildSnapshot({ tierKey: "membership_types", tier, record: autopay, extras });
  assert.equal(snap.prices.length, 1);
  assert.equal(snap.prices[0].amount, 552, "the level total is a year's worth");
  assert.deepEqual(snap.prices[0].schedules, [
    { id: "a2qa1", name: "Adult Membership", termType: "Monthly", amount: 46, totalAmount: 552, numberOfTerms: null }
  ]);
  assert.equal(snap.TREX1__Product__r.TREX1__Price_Description__c, "$46.00 a Month");
});

test("class prices are unchanged: no schedules key, so class hashes do not move", () => {
  const snap = buildSnapshot({
    tierKey: "classes",
    tier: TIERS.classes,
    record: { Id: "a1ua1", TREX1__Course_Option__r: { TREX1__Product__c: "a2xa1" }, SystemModstamp: "x" },
    extras
  });
  assert.deepEqual(Object.keys(snap.prices[0]), ["id", "name", "priceType", "amount", "initialFee"]);
});

test("membership types group under their category", () => {
  const rel = relations().find((r) => r.childTierKey === "membership_types");
  const row = (id, name) => ({ Id: id, Name: name, TREX1__Category__c: "a2la1", meta: { tractionrecId: id, hash: id } });
  const { files } = buildChildrenFiles({
    ...rel,
    parentIds: ["a2la1", "a2la2"],
    childRows: [row("a2mb", "Senior Membership - Annual"), row("a2ma", "Adult Membership - Annual")]
  });
  assert.equal(files[0].filename, "/tractionrec/membership_categories/a2la1/membership_types.json");
  assert.deepEqual(files[0].rows.map((r) => r.Name), ["Adult Membership - Annual", "Senior Membership - Annual"]);
  assert.deepEqual(files[1].rows, [], "a category with nothing online still gets []");
});
