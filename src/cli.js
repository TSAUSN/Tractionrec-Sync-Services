"use strict";

/**
 * Local runner for the sync. `npm run sync:dry` plans a run and writes
 * nothing; `npm run sync -- --live` writes.
 *
 *   --datasets=tr_products,tr_price_levels   only these (relations to the
 *                                            others resolve from the instance)
 *   --live | --dry                           override DRY_RUN
 *   --summary                                counts only, not every row
 *
 * Reads .env if present. Nothing here is used by the deployed function.
 */
const fs = require("node:fs");
const path = require("node:path");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const { run } = require("./datasets/run");

const args = process.argv.slice(2);
const overrides = {};
for (const arg of args) {
  if (arg.startsWith("--datasets=")) {
    overrides.datasets = arg.slice("--datasets=".length).split(",").filter(Boolean);
  }
  if (arg === "--live") {
    overrides.dryRun = false;
  }
  if (arg === "--dry") {
    overrides.dryRun = true;
  }
}
const summary = args.includes("--summary");

const brief = (report) => ({
  ...report,
  datasets: Object.fromEntries(
    Object.entries(report.datasets).map(([k, d]) => [
      k,
      {
        ...d,
        deactivated: d.deactivated.length,
        reactivated: d.reactivated.length,
        pagesCreated: d.pagesCreated.length,
        pagesRenamed: d.pagesRenamed.length,
        unresolved: d.unresolved.length,
        duplicates: d.duplicates.length,
        warnings: d.warnings.length
      }
    ])
  )
});

run(overrides)
  .then((report) => {
    process.stdout.write(JSON.stringify(summary ? brief(report) : report, null, 2) + "\n");
    process.exit(report.errorCount > 0 ? 1 : 0);
  })
  .catch((err) => {
    process.stderr.write((err.stack || err.message) + "\n");
    process.exit(1);
  });
