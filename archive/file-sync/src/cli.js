"use strict";

/**
 * Local runner. `npm run sync:dry` plans a run and writes nothing.
 *
 * Reads a .env file if one is present, so a developer can work without
 * Secret Manager. Nothing here is used in the deployed function.
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

const { run } = require("./sync/run");

const args = process.argv.slice(2);
const overrides = {};
for (const arg of args) {
  if (arg.startsWith("--tiers=")) {
    overrides.tiers = arg.slice(8).split(",").filter(Boolean);
  }
  if (arg === "--live") {
    overrides.dryRun = false;
  }
  if (arg === "--dry") {
    overrides.dryRun = true;
  }
}

run(overrides)
  .then((report) => {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exit(report.errorCount > 0 ? 1 : 0);
  })
  .catch((err) => {
    process.stderr.write((err.stack || err.message) + "\n");
    process.exit(1);
  });
