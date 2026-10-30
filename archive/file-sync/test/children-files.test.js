"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildChildrenFiles, derivedHash, relations, childrenPath } = require("../src/sync/children-files");
const { writeDerivedFile } = require("../src/sync/tier-files");

const row = (id, fields = {}, meta = {}) => ({
  Id: id,
  ...fields,
  meta: { tractionrecId: id, hash: `h-${id}`, zestyItemZuid: `7-${id}`, syncedAt: "t0", ...meta }
});
const course = (id, name, programId) => row(id, { Name: name, TREX1__Program__c: programId });
const program = (id, name, categoryIds) => row(id, { Name: name, TREX1__Program_Category__c: categoryIds });

const build = (childTierKey, parentIds, childRows) => {
  const rel = relations().find((r) => r.childTierKey === childTierKey);
  return buildChildrenFiles({ ...rel, parentIds, childRows });
};
const rowsOf = (result, parentId) => result.files.find((f) => f.parentId === parentId).rows.map((r) => r.Id);

test("the four relationships come from the tier map", () => {
  assert.deepEqual(
    relations().map((r) => `${r.parentTierKey}/<id>/${r.childTierKey}.json`),
    [
      "program_categories/<id>/programs.json",
      "programs/<id>/courses.json",
      "courses/<id>/classes.json",
      "membership_categories/<id>/membership_types.json"
    ]
  );
  assert.equal(childrenPath("programs", "a31x", "courses"), "/tractionrec/programs/a31x/courses.json");
});

test("one-to-many: each program's courses, full rows, sorted by name then Id", () => {
  const result = build("courses", ["p1", "p2"], [
    course("c3", "Swim B", "p1"),
    course("c1", "Swim A", "p1"),
    course("c2", "swim a", "p1"),
    course("c9", "Boxing", "p2")
  ]);
  assert.deepEqual(rowsOf(result, "p1"), ["c1", "c2", "c3"], "case-insensitive name, then Id");
  assert.deepEqual(rowsOf(result, "p2"), ["c9"]);
  assert.equal(result.files[0].rows[0].Name, "Swim A", "rows are copied in full, not as ids");
});

test("every synced parent gets a file, [] when it has no children", () => {
  const result = build("courses", ["p1", "p-empty"], [course("c1", "A", "p1")]);
  assert.equal(result.files.length, 2);
  assert.deepEqual(rowsOf(result, "p-empty"), []);
});

test("many-to-many: a program tagged into two categories is in both files", () => {
  const result = build("programs", ["sports", "youth", "arts"], [
    program("pA", "Basketball", ["sports", "youth"]),
    program("pB", "Painting", ["arts"])
  ]);
  assert.deepEqual(rowsOf(result, "sports"), ["pA"]);
  assert.deepEqual(rowsOf(result, "youth"), ["pA"]);
  assert.deepEqual(rowsOf(result, "arts"), ["pB"]);
  assert.deepEqual(
    result.files.find((f) => f.parentId === "sports").rows[0],
    result.files.find((f) => f.parentId === "youth").rows[0],
    "the copies are identical"
  );
});

test("untagging rebuilds correctly: out of one category, still in the other", () => {
  const before = build("programs", ["sports", "youth"], [program("pA", "Basketball", ["sports", "youth"])]);
  const after = build("programs", ["sports", "youth"], [program("pA", "Basketball", ["youth"])]);
  assert.deepEqual(rowsOf(after, "sports"), [], "dropped from sports' file");
  assert.deepEqual(rowsOf(after, "youth"), ["pA"], "kept in youth's file");
  const sports = (r) => r.files.find((f) => f.parentId === "sports").rows;
  assert.notEqual(derivedHash(sports(before)), derivedHash(sports(after)), "so the file is rewritten");
});

test("a duplicated tag does not list a program twice in one category", () => {
  const result = build("programs", ["sports"], [program("pA", "Basketball", ["sports", "sports"])]);
  assert.deepEqual(rowsOf(result, "sports"), ["pA"]);
});

test("class -> course follows the nested lookup Salesforce returns", () => {
  const cls = row("k1", {
    TREX1__Course_Option__r: { Name: "Level 2" },
    TREX1__cso_Course_Session__r: { TREX1__Course__c: "c1" }
  });
  assert.deepEqual(rowsOf(build("classes", ["c1"], [cls]), "c1"), ["k1"]);
});

test("children whose parent is not synced are reported, not silently dropped", () => {
  const result = build("courses", ["p1"], [course("c1", "A", "p1"), course("c2", "B", "p-gone")]);
  assert.deepEqual(result.unparented, [{ id: "c2", parents: ["p-gone"] }]);
});

test("the derived hash ignores syncedAt but not content, Zesty item or order", () => {
  const a = [course("c1", "A", "p1"), course("c2", "B", "p1")];
  const resynced = a.map((r) => ({ ...r, meta: { ...r.meta, syncedAt: "t1" } }));
  assert.equal(derivedHash(a), derivedHash(resynced), "a quiet run writes nothing");
  assert.notEqual(derivedHash(a), derivedHash([a[1], a[0]]), "order");
  assert.notEqual(derivedHash(a), derivedHash([{ ...a[0], meta: { ...a[0].meta, hash: "x" } }, a[1]]), "content");
  assert.notEqual(derivedHash(a), derivedHash([{ ...a[0], meta: { ...a[0].meta, zestyItemZuid: "7-z" } }, a[1]]), "item");
});

test("a derived file is skipped only while its hash matches AND the view still exists", async () => {
  const rows = [course("c1", "A", "p1")];
  const filename = "/tractionrec/programs/p1/courses.json";
  const state = { files: { [filename]: derivedHash(rows) } };
  const present = new Map([[filename, { zuid: "11-x", version: 1 }]]);

  const same = await writeDerivedFile(null, present, state, { filename, rows, dryRun: true });
  assert.equal(same.action, "unchanged");

  const deleted = await writeDerivedFile(null, new Map(), state, { filename, rows, dryRun: true });
  assert.equal(deleted.action, "would-create", "a reset view is recreated, not trusted");
});
