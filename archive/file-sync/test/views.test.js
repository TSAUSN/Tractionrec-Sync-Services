"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { parsleySafeJson, snapshotPath, indexViewRows } = require("../src/zesty/views");

test("snapshots are filed under /tractionrec/<tier>/<id>.json, with the leading slash", () => {
  // Without the leading slash the API accepts the view, reports it live, and
  // then 404s on every request. Verified on the instance 2026-09-25.
  assert.equal(
    snapshotPath("program_categories", "a0X1U000001abcUAA"),
    "/tractionrec/program_categories/a0X1U000001abcUAA.json"
  );
});

test("the view index normalises slashes, so a lookup cannot miss on form alone", () => {
  const index = indexViewRows([
    { ZUID: "11-a", fileName: "/tractionrec/program_categories/a0A1.json", version: 1, status: "live" },
    { ZUID: "11-b", fileName: "custom-endpoints/categories.json", version: 1, status: "live" }
  ]);
  assert.ok(index.has("/tractionrec/program_categories/a0A1.json"));
  assert.ok(index.has("/custom-endpoints/categories.json"));
});

test("a double-open-curly in Traction Rec content never reaches the view source", () => {
  const code = parsleySafeJson({
    description: "Ages 5+ {{globals.site_name}} <b>Swim</b>"
  });

  // Parsley scans the raw view, so the literal sequence must not appear in it.
  assert.ok(!code.includes("{{"), "escaped source still contains a Parsley open tag");

  // ...while a JSON parser still sees the author's original text.
  assert.equal(JSON.parse(code).description, "Ages 5+ {{globals.site_name}} <b>Swim</b>");
});

test("ordinary JSON braces are untouched", () => {
  const code = parsleySafeJson({ nested: { a: 1 } });
  assert.deepEqual(JSON.parse(code), { nested: { a: 1 } });
  assert.ok(code.includes('"nested"'));
});

test("the view index keeps the highest version when a view is listed per status", () => {
  // /web/views returns one row per status: the same ZUID appears as `dev` and
  // as `live`, with different versions when there are unpublished edits.
  const rows = [
    { ZUID: "11-abc", fileName: "/tractionrec/program_categories/a0A1.json", version: 3, status: "dev", type: "ajax-json" },
    { ZUID: "11-abc", fileName: "/tractionrec/program_categories/a0A1.json", version: 2, status: "live", type: "ajax-json" }
  ];

  const index = indexViewRows(rows);
  assert.equal(index.size, 1, "the two status rows are one view");
  assert.equal(index.get("/tractionrec/program_categories/a0A1.json").version, 3);
});

test("row order does not change the indexed version", () => {
  const rows = [
    { ZUID: "11-abc", fileName: "/a.json", version: 2, status: "live" },
    { ZUID: "11-abc", fileName: "/a.json", version: 5, status: "dev" }
  ];
  assert.equal(indexViewRows(rows).get("/a.json").version, 5);
  assert.equal(indexViewRows(rows.slice().reverse()).get("/a.json").version, 5);
});

test("closing tags are escaped so a file can be inlined inside a <script>", () => {
  const { parsleySafeJson } = require("../src/zesty/views");
  const out = parsleySafeJson({ html: "<p>Swim</p></script><script>alert(1)</script>" });
  assert.ok(!out.includes("</"), "no literal closing tag survives");
  assert.equal(JSON.parse(out).html, "<p>Swim</p></script><script>alert(1)</script>", "same string once parsed");
});
