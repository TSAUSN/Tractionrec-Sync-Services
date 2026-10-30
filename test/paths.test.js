"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { uniquePathPart, collectUsedPaths } = require("../src/datasets/paths");

test("a free path part is used as-is", () => {
  const used = new Set();
  assert.equal(uniquePathPart("Swim Lessons", null, used), "swim-lessons");
  assert.ok(used.has("swim-lessons"));
});

test("a taken path part falls back to the parent's prefix", () => {
  // The real collision: the Boxing CATEGORY already owns /boxing/, and the
  // Boxing PROGRAM sits under the Sports category.
  const used = new Set(["boxing"]);
  assert.equal(uniquePathPart("Boxing", "sports", used), "sports-boxing");
});

test("two same-named courses under different programs both resolve", () => {
  const used = new Set();
  assert.equal(uniquePathPart("4-6 Age Division", "basketball", used), "4-6-age-division");
  assert.equal(uniquePathPart("4-6 Age Division", "soccer", used), "soccer-4-6-age-division");
});

test("a numeric suffix is the fallback when there is no parent", () => {
  const used = new Set(["boxing"]);
  assert.equal(uniquePathPart("Boxing", null, used), "boxing-2");
  assert.equal(uniquePathPart("Boxing", null, used), "boxing-3");
});

test("the numeric fallback also applies when the prefixed form is taken", () => {
  const used = new Set(["boxing", "sports-boxing"]);
  assert.equal(uniquePathPart("Boxing", "sports", used), "boxing-2");
});

test("existing item paths are collected with slashes stripped", () => {
  const used = collectUsedPaths([
    [{ web: { pathPart: "aquatics" } }, { web: { path: "/senior-activities/" } }, { web: {} }]
  ]);
  assert.deepEqual([...used].sort(), ["aquatics", "senior-activities"]);
});

test("a prefix that only repeats the name is skipped", () => {
  // The Senior Activities program sits under the Senior Activities category.
  const used = new Set(["senior-activities"]);
  assert.equal(uniquePathPart("Senior Activities", "senior-activities", used), "senior-activities-2");
});

test("a prefix already contained in the name is skipped", () => {
  const used = new Set(["boxing-level-2"]);
  assert.equal(uniquePathPart("Boxing Level 2", "boxing", used), "boxing-level-2-2");
});

test("a prefix that genuinely disambiguates is still used", () => {
  const used = new Set(["adult-boxing"]);
  assert.equal(uniquePathPart("Adult Boxing", "sports-boxing", used), "sports-boxing-adult-boxing");
});
