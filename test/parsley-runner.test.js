"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { wrapCode, extractOutput, classify, allowedOrigins, CRASH_TEXT } = require("../src/parsley-runner");

test("output is read back from between this run's markers", () => {
  const page = `<html><template>${wrapCode("<b>hi</b>", "n1")}</template></html>`;
  assert.equal(extractOutput(page, "n1"), "<b>hi</b>");
});

test("a page carrying another run's markers is stale, not this run's output", () => {
  const page = wrapCode("old", "n0");
  assert.equal(extractOutput(page, "n1"), null);
  assert.equal(classify(200, page, "n1"), "stale");
});

test("a 500 or Zesty's build-error page is a crash", () => {
  assert.equal(classify(500, "<h1>…</h1>", "n1"), "crash");
  assert.equal(classify(200, `<h1>${CRASH_TEXT}</h1>`, "n1"), "crash");
  assert.equal(classify(200, wrapCode("ok", "n1"), "n1"), "fresh");
});

test("empty output is still a fresh result", () => {
  assert.equal(extractOutput(wrapCode("", "n1"), "n1"), "");
  assert.equal(classify(200, wrapCode("", "n1"), "n1"), "fresh");
});

test("only the instance's own domains may drive the runner", () => {
  const o = allowedOrigins("kroc.zesty.dev", "6wz46m14");
  assert.ok(o.has("https://kroc.zesty.dev"));
  assert.ok(o.has("https://6wz46m14-dev.webengine.zesty.io"));
  assert.ok(!o.has("https://evil.example"));
  assert.ok(!o.has("http://kroc.zesty.dev"), "https only");
});
