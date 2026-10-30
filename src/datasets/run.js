"use strict";

/**
 * The sync: Traction Rec -> the nine tr_* Zesty datasets, plus the catalog's
 * page items (docs/dataset-sync.md, docs/dataset-storage.md).
 *
 * A run:
 *   1. checks the definitions against zesty-models/*.json, and the live models
 *      against those specs; any mismatch stops it before a write
 *   2. reads Traction Rec's published set (source.fetchAll)
 *   3. per dataset, in dependency order:
 *      a. finds the ids it knows that are NOT published now — its items, and
 *         for catalog datasets their page items — and re-reads them without
 *         the gate (source.fetchByIds) for their current values and reason
 *      b. creates the missing page items (pages.js)
 *      c. plans every row (plan.js): published -> active, the rest -> active 0
 *      d. creates / updates + publishes only what changed
 *      e. a renamed record's page follows: title + SEO title, never the URL
 *
 * Nothing is deleted. DRY_RUN (default on) plans and writes nothing.
 * `overrides.source` replaces Traction Rec (the scenario tests).
 */

const { load } = require("../config");
const { TractionRecClient } = require("../tractionrec/client");
const { connect } = require("../zesty/client");
const { indexModels, indexItems } = require("../zesty/items");
const { DATASETS } = require("./definitions");
const { loadSpecs, checkDefinitions, checkInstance } = require("./schema");
const { tractionRecSource } = require("./fetch");
const { planDataset } = require("./plan");
const { createAndPublish, updateAndPublish } = require("./write");
const { createMissingPages, renamePage } = require("./pages");
const { collectUsedPaths } = require("./paths");
const log = require("../logger");

/** Stand-in ZUID for an item a dry run would have created; never written. */
const DRY_RUN_ZUID = "7-000000000000-dryrun";

const PAGE_MODELS = DATASETS.filter((d) => d.page).map((d) => d.page.model);

const zuidMap = (byTrId) => new Map([...byTrId].map(([trId, item]) => [trId, item.meta.ZUID]));

async function run(overrides = {}) {
  const cfg = { ...load(), ...overrides };
  const selected = cfg.datasets && cfg.datasets.length ? cfg.datasets : DATASETS.map((d) => d.key);
  for (const key of selected) {
    if (!DATASETS.some((d) => d.key === key)) {
      throw new Error(`Unknown dataset "${key}". Known: ${DATASETS.map((d) => d.key).join(", ")}`);
    }
  }
  const startedAt = new Date();
  log.info("sync.start", { datasets: selected, dryRun: cfg.dryRun });

  // 1. definitions <-> specs <-> instance
  const specs = loadSpecs();
  const defProblems = checkDefinitions(specs);
  if (defProblems.length) {
    throw new Error(`Dataset definitions do not match zesty-models/:\n  ${defProblems.join("\n  ")}`);
  }
  const zesty = cfg.zestyClient || (await connect(cfg.zesty));
  const models = await indexModels(zesty);
  const { problems, fieldsByDataset } = await checkInstance(zesty, models, specs);
  if (problems.length) {
    throw new Error(`Dataset models do not match zesty-models/:\n  ${problems.join("\n  ")}`);
  }
  for (const name of PAGE_MODELS) {
    if (!models.get(name)) {
      throw new Error(`Page model "${name}" not found on the instance`);
    }
  }

  // 2. Traction Rec
  const source = cfg.source || tractionRecSource(new TractionRecClient(cfg.tr));
  const tr = await source.fetchAll();

  // What the instance holds: every dataset's items (a relation may point at
  // one not in this run) and the catalog page items.
  const indexes = new Map();
  const zuids = new Map();
  for (const ds of DATASETS) {
    const index = await indexItems(zesty, models.get(ds.key));
    indexes.set(ds.key, index);
    zuids.set(ds.key, zuidMap(index.byTrId));
  }
  const pageItems = new Map();
  const allPages = [];
  for (const name of PAGE_MODELS) {
    const index = await indexItems(zesty, models.get(name));
    pageItems.set(name, new Map(index.byTrId));
    allPages.push(index.all);
  }
  // Path parts are unique across the four page models (one root namespace).
  const usedPaths = collectUsedPaths(allPages);
  const pageZuids = () =>
    new Map([...pageItems].map(([model, byTrId]) => [model, zuidMap(byTrId)]));

  // 3. datasets, in dependency order
  const report = { startedAt: startedAt.toISOString(), dryRun: cfg.dryRun, datasets: {} };
  for (const ds of DATASETS) {
    if (!selected.includes(ds.key)) {
      continue;
    }
    const modelZuid = models.get(ds.key);
    const items = indexes.get(ds.key);
    const records = ds.source(tr);
    const published = new Set(records.map((r) => r.Id));
    const outcome = {
      trRecords: records.length,
      created: 0,
      updated: 0,
      unchanged: 0,
      active: 0,
      inactive: 0,
      deactivated: [],
      reactivated: [],
      pagesCreated: [],
      pagesRenamed: [],
      unresolved: [],
      duplicates: [],
      warnings: [],
      errors: []
    };

    // a. known ids outside the published set
    const known = new Set(items.byTrId.keys());
    if (ds.page) {
      for (const trId of pageItems.get(ds.page.model).keys()) {
        known.add(trId);
      }
    }
    const gone = [...known].filter((trId) => !published.has(trId));
    let inactive = new Map(gone.map((trId) => [trId, null]));
    if (ds.tier && gone.length) {
      const found = await source.fetchByIds(ds.tier, gone);
      inactive = new Map(gone.map((trId) => [trId, found.get(trId) || null]));
    }

    // b. pages for published records that have none
    if (ds.page) {
      const pages = await createMissingPages({ zesty, ds, records, tr, models, pageItems, usedPaths, dryRun: cfg.dryRun });
      outcome.pagesCreated = pages.created;
      outcome.errors.push(...pages.errors);
    }

    // c. plan
    const plan = planDataset({
      ds,
      records,
      inactive,
      tr,
      types: fieldsByDataset.get(ds.key),
      items,
      zuids,
      pages: pageZuids(),
      now: startedAt
    });
    outcome.unchanged = plan.unchanged.length;
    outcome.deactivated = plan.deactivated;
    outcome.reactivated = plan.reactivated;
    outcome.unresolved = plan.unresolved;
    outcome.duplicates = plan.duplicates;
    outcome.warnings = plan.warnings;
    for (const entry of [...plan.create, ...plan.update, ...plan.unchanged]) {
      outcome[entry.active ? "active" : "inactive"]++;
    }

    // This dataset's ZUIDs for the datasets after it: every row it holds now,
    // active or not, so children keep resolving to an inactive parent.
    const resolved = new Map(plan.unchanged.map((u) => [u.trId, u.zuid]));

    // d. writes
    for (const entry of plan.create) {
      if (cfg.dryRun) {
        resolved.set(entry.trId, DRY_RUN_ZUID);
        outcome.created++;
        continue;
      }
      try {
        resolved.set(entry.trId, await createAndPublish(zesty, modelZuid, entry));
        outcome.created++;
      } catch (err) {
        outcome.errors.push({ stage: "create", trId: entry.trId, error: err.message });
        log.error("sync.create.failed", { dataset: ds.key, trId: entry.trId, error: err.message });
      }
    }
    for (const entry of plan.update) {
      // A record whose update fails still has its item, so children can
      // still point at it.
      resolved.set(entry.trId, entry.zuid);
      if (!cfg.dryRun) {
        try {
          await updateAndPublish(zesty, modelZuid, entry);
        } catch (err) {
          outcome.errors.push({ stage: "update", trId: entry.trId, error: err.message });
          log.error("sync.update.failed", { dataset: ds.key, trId: entry.trId, error: err.message });
          continue;
        }
      }
      outcome.updated++;

      // e. a rename reaches the page's title + SEO title (never its URL)
      if (ds.page && entry.renamed) {
        try {
          if (await renamePage({ zesty, ds, trId: entry.trId, name: entry.name, models, pageItems, dryRun: cfg.dryRun })) {
            outcome.pagesRenamed.push({ trId: entry.trId, name: entry.name });
          }
        } catch (err) {
          outcome.errors.push({ stage: "renamePage", trId: entry.trId, error: err.message });
          log.error("pages.rename.failed", { dataset: ds.key, trId: entry.trId, error: err.message });
        }
      }
    }

    zuids.set(ds.key, resolved);
    report.datasets[ds.key] = outcome;
    log.info("sync.dataset.done", {
      dataset: ds.key,
      trRecords: outcome.trRecords,
      created: outcome.created,
      updated: outcome.updated,
      unchanged: outcome.unchanged,
      active: outcome.active,
      inactive: outcome.inactive,
      deactivated: outcome.deactivated.length,
      reactivated: outcome.reactivated.length,
      pagesCreated: outcome.pagesCreated.length,
      pagesRenamed: outcome.pagesRenamed.length,
      errors: outcome.errors.length
    });
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt.getTime();
  report.errorCount = Object.values(report.datasets).reduce((n, d) => n + d.errors.length, 0);
  log.info("sync.done", { durationMs: report.durationMs, errorCount: report.errorCount });
  return report;
}

module.exports = { run, DRY_RUN_ZUID };
