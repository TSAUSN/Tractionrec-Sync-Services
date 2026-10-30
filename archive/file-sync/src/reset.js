"use strict";

/**
 * Remove everything this service has written, so a sync can be re-run from a
 * clean slate.
 *
 * Two kinds of thing get removed, and they carry very different risk:
 *
 *   1. **Snapshot views** under `/tractionrec/` — pure machine output. Nothing
 *      but this service writes there, so deleting them is safe and reversible
 *      by re-running the sync.
 *
 *   2. **Zesty content items** carrying a `tractionrec_id` — NOT purely machine
 *      output. An editor may have written a hero image, body copy or SEO text
 *      on one since it was created, and deleting it destroys that along with
 *      the URL, which may be linked or indexed. Items are therefore left alone
 *      unless `--items` is passed explicitly.
 *
 * An item with NO `tractionrec_id` is never touched under any flag — those are
 * hand-authored pages this service did not create.
 *
 *   node src/reset.js                  # plan only, deletes nothing
 *   node src/reset.js --live           # delete the snapshot views
 *   node src/reset.js --live --items   # ...and the items this service created
 *   node src/reset.js --live --tiers=classes
 */

const { load, TIERS, SNAPSHOT_ROOT, TR_ID_FIELD } = require("./config");
const { connect, ok } = require("./zesty/client");
const { indexModels, indexItems } = require("./zesty/items");
const log = require("./logger");

/** The SDK has no deleteView, but the API supports it. Verified 2026-09-30. */
async function deleteView(zesty, zuid) {
  return ok(await zesty.instance.deleteRequest(`/web/views/${zuid}`), `deleteView ${zuid}`);
}

async function reset({ live = false, items = false, tiers = null } = {}) {
  const cfg = load();
  const zesty = await connect(cfg.zesty);
  const scope = tiers && tiers.length ? tiers : Object.keys(TIERS);

  log.info("reset.start", { live, items, tiers: scope, note: live ? "DELETING" : "plan only" });

  const report = { live, views: { found: 0, deleted: 0, errors: [] }, items: {} };

  // ---- snapshot views -----------------------------------------------------
  const listing = ok(await zesty.instance.getViews(), "getViews");
  const byZuid = new Map();
  for (const v of listing.data || []) {
    const file = v.fileName || v.filename || "";
    if (!file.startsWith(`${SNAPSHOT_ROOT}/`)) {
      continue;
    }
    // When tiers are named, keep the reset to those folders. The state ledger
    // and any _index/_children files are only removed on a full reset, because
    // a partial one would leave them describing records that still exist.
    if (tiers && tiers.length) {
      const inScope = scope.some((t) => file.startsWith(`${SNAPSHOT_ROOT}/${t}/`));
      if (!inScope) {
        continue;
      }
    }
    byZuid.set(v.ZUID, file);
  }

  report.views.found = byZuid.size;
  log.info("reset.views.found", { count: byZuid.size, root: SNAPSHOT_ROOT });

  for (const [zuid, file] of byZuid) {
    if (!live) {
      log.info("reset.view", { action: "would-delete", file, zuid });
      continue;
    }
    try {
      await deleteView(zesty, zuid);
      report.views.deleted++;
      log.info("reset.view", { action: "deleted", file, zuid });
    } catch (err) {
      report.views.errors.push({ file, error: err.message });
      log.error("reset.view.failed", { file, error: err.message });
    }
  }

  // ---- content items ------------------------------------------------------
  const models = await indexModels(zesty);

  for (const tierKey of scope) {
    const modelZuid = models.get(TIERS[tierKey].zestyModel);
    if (!modelZuid) {
      continue;
    }

    const index = await indexItems(zesty, modelZuid);
    const linked = [...index.byTrId.values()];
    const result = { linked: linked.length, untouched: index.unlinked.length, deleted: 0, errors: [] };

    if (!items) {
      result.skipped = linked.length;
      log.info("reset.items.skipped", {
        tier: tierKey,
        linked: linked.length,
        message: "pass --items to delete these; editorial content on them would go too"
      });
      report.items[tierKey] = result;
      continue;
    }

    for (const item of linked) {
      const zuid = item.meta.ZUID;
      if (!live) {
        log.info("reset.item", { action: "would-delete", tier: tierKey, zuid, trId: item.data[TR_ID_FIELD] });
        continue;
      }
      try {
        ok(await zesty.instance.deleteItem(modelZuid, zuid), `deleteItem ${zuid}`);
        result.deleted++;
        log.info("reset.item", { action: "deleted", tier: tierKey, zuid });
      } catch (err) {
        result.errors.push({ zuid, error: err.message });
        log.error("reset.item.failed", { tier: tierKey, zuid, error: err.message });
      }
    }

    report.items[tierKey] = result;
  }

  log.info("reset.done", {
    live,
    viewsDeleted: report.views.deleted,
    viewsFound: report.views.found
  });

  return report;
}

module.exports = { reset };

if (require.main === module) {
  const fs = require("node:fs");
  const path = require("node:path");
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  }

  const argv = process.argv.slice(2);
  const tiersArg = argv.find((a) => a.startsWith("--tiers="));
  const opts = {
    live: argv.includes("--live"),
    items: argv.includes("--items"),
    tiers: tiersArg ? tiersArg.slice(8).split(",").filter(Boolean) : null
  };

  if (!opts.live) {
    process.stderr.write("\n  PLAN ONLY — nothing will be deleted. Add --live to apply.\n\n");
  }

  reset(opts)
    .then((r) => {
      process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      process.exit(r.views.errors.length ? 1 : 0);
    })
    .catch((err) => {
      process.stderr.write((err.stack || err.message) + "\n");
      process.exit(1);
    });
}
