"use strict";

/**
 * Live-cache check: when the sync publishes a changed tr_* item, do the LIVE
 * pages that print it show the change, and how soon?
 *
 *   npm run test:live-cache
 *
 * Needs the site code published to the live domain first (the catalog page
 * views, components and views/datasets/*.json). The live domain sits behind
 * two Varnish layers that cache pages even with cache-control: no-cache
 * (x-cache: MISS, HIT seen 2026-10-29), so a dataset publish has to purge the
 * pages that read the dataset — this checks that it does.
 *
 * What it does, on one real active class:
 *   1. warms the live class page and its course page
 *   2. writes the class row with a different spot count (and a stale hash, so
 *      the next sync puts it back), publishes it
 *   3. polls both live pages until they show the new count (or times out)
 *   4. runs the real sync, which restores the row, and polls until the pages
 *      show the real count again
 * The row is the sync's own data; it ends as the sync left it.
 */

const fs = require("node:fs");
const path = require("node:path");

const envPath = path.join(__dirname, "..", "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const { load } = require("../../src/config");
const { connect, ok } = require("../../src/zesty/client");
const { indexModels, indexItems } = require("../../src/zesty/items");
const { run } = require("../../src/datasets/run");

const LIVE = process.env.ZESTY_LIVE_URL || "https://kroc.zesty.dev";
const TIMEOUT_MS = Number(process.env.LIVE_CACHE_TIMEOUT_MS || 10 * 60 * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function live(urlPath) {
  const res = await fetch(`${LIVE}${urlPath}`);
  return { html: await res.text(), cache: res.headers.get("x-cache") || "", age: res.headers.get("age") || "" };
}

/** Poll until every path shows `needle`; returns seconds taken, or null. */
async function waitFor(paths, needle) {
  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    const pages = await Promise.all(paths.map(live));
    if (pages.every((p) => p.html.includes(needle))) {
      return Math.round((Date.now() - t0) / 1000);
    }
    await sleep(10000);
  }
  return null;
}

async function main() {
  const cfg = load();
  const zesty = await connect(cfg.zesty);
  const models = await indexModels(zesty);
  const classesModel = models.get("tr_classes");
  const rows = (await indexItems(zesty, classesModel)).all;
  const row = rows.find((r) => String(r.data.active) === "1" && r.data.page && r.data.course && r.data.capacity_available !== null);
  if (!row) {
    throw new Error("no active class with a page, a course and a spot count");
  }
  const pagePath = async (model, zuid) => {
    const item = (await indexItems(zesty, models.get(model))).all.find((i) => i.meta.ZUID === zuid);
    return item.web.path || `/${item.web.pathPart}/`;
  };
  const classPath = await pagePath("classes", row.data.page);
  const courseRow = (await indexItems(zesty, models.get("tr_courses"))).all.find((i) => i.meta.ZUID === row.data.course);
  const coursePath = await pagePath("courses", courseRow.data.page);
  const real = Number(row.data.capacity_available);
  const fake = real + 37;
  console.log(`class "${row.data.name}" ${classPath} (course ${coursePath}): spots ${real} -> ${fake} -> ${real}`);

  const warm = await Promise.all([classPath, coursePath, classPath, coursePath].map(live));
  console.log("warm-up x-cache:", warm.map((w) => w.cache || "-").join(" | "));
  const needle = (n) => `"capacity_available": "${n}"`;
  if (!warm[0].html.includes(needle(real))) {
    throw new Error("the live class page doesn't print the dataset row: publish the site code first");
  }

  // 2. change + publish
  const put = ok(
    await zesty.instance.updateItem(classesModel, row.meta.ZUID, {
      data: { ...row.data, capacity_available: fake, sync_hash: "live-cache-test" },
      meta: { masterZUID: row.meta.ZUID, listed: true },
      web: { metaTitle: row.web.metaTitle }
    }),
    "updateItem"
  );
  ok(await zesty.instance.publishItem(classesModel, row.meta.ZUID, put.data.version), "publishItem");
  console.log(`published v${put.data.version} with spots ${fake}`);

  const shown = await waitFor([classPath, coursePath], needle(fake));
  console.log(shown === null ? `✘ the live pages did NOT show the change within ${TIMEOUT_MS / 1000} s` : `✔ the live pages showed the change after ~${shown} s`);

  // 4. the sync restores it
  const report = await run({ dryRun: false, datasets: ["tr_classes"], zestyClient: zesty });
  console.log(`sync restored it: ${report.datasets.tr_classes.updated} updated, ${report.errorCount} errors`);
  const back = await waitFor([classPath, coursePath], needle(real));
  console.log(back === null ? `✘ the live pages did NOT show the restored value within ${TIMEOUT_MS / 1000} s` : `✔ the live pages showed the restored value after ~${back} s`);
  process.exit(shown === null || back === null ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
