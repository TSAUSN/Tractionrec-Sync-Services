"use strict";

const { load, TIERS, TR_ID_FIELD } = require("../config");
const { TractionRecClient } = require("../tractionrec/client");
const { fetchTier } = require("../tractionrec/fetch-tier");
const { connect } = require("../zesty/client");
const {
  indexModels,
  indexItems,
  createItem,
  requiredFieldsFor,
  loadSeedTemplate
} = require("../zesty/items");
const { indexViews, writeSnapshot, snapshotPath } = require("../zesty/views");
const { reconcile, orphansAreMeaningful } = require("./reconcile");
const { readState, writeState, hashesFor } = require("./state");
const { uniquePathPart, collectUsedPaths } = require("./paths");
const log = require("../logger");

/** Stand-in for an item a dry run would have created. Never written anywhere. */
const DRY_RUN_ZUID = "7-000000000000-dryrun";

/**
 * One full pass. Tiers run in dependency order, because a child's Zesty item
 * needs its parent's ZUID to exist before it can link to it.
 */
async function run(overrides = {}) {
  const cfg = { ...load(), ...overrides };
  const startedAt = new Date();

  log.info("sync.start", {
    tiers: cfg.tiers,
    dryRun: cfg.dryRun,
    createMissingItems: cfg.createMissingItems
  });

  const tr = new TractionRecClient(cfg.tr);
  const zesty = await connect(cfg.zesty);

  const [models, viewIndex] = await Promise.all([indexModels(zesty), indexViews(zesty)]);
  const state = await readState(zesty, viewIndex);

  /**
   * Path parts already taken. The catalog models are not nested, so every item
   * across all four shares one root namespace and a duplicate is a hard 400.
   *
   * This must cover EVERY catalog model, not just the tiers in this run: the
   * first live run failed because the Boxing program collided with the Boxing
   * *category*, which that run never touched.
   */
  const usedPaths = new Set();
  for (const key of Object.keys(TIERS)) {
    const zuid = models.get(TIERS[key].zestyModel);
    if (!zuid) {
      continue;
    }
    const items = await indexItems(zesty, zuid);
    for (const part of collectUsedPaths([items.all])) {
      usedPaths.add(part);
    }
  }
  log.info("sync.paths.indexed", { taken: usedPaths.size });

  /** tierKey -> Map(tractionRecId -> Zesty item ZUID), used to link children. */
  const zuidByTrId = new Map();

  /**
   * The parent index for a tier, loaded from the instance when that tier is
   * not part of this run.
   *
   * Without this, `--tiers=class` alone would skip every class: the parent map
   * is built as tiers are processed, so a run that does not include `course`
   * would find no parent for anything. That is not an edge case — the
   * recommended schedule deliberately splits the tiers across two cron jobs
   * (structure daily, classes every 30 minutes).
   */
  async function parentIndexFor(tierKey) {
    const parentTier = TIERS[tierKey].parentTier;
    if (!parentTier) {
      return new Map();
    }
    if (zuidByTrId.has(parentTier)) {
      return zuidByTrId.get(parentTier);
    }

    const parentModelZuid = models.get(TIERS[parentTier].zestyModel);
    if (!parentModelZuid) {
      throw new Error(
        `Zesty model "${TIERS[parentTier].zestyModel}" not found; cannot resolve parents for ${tierKey}.`
      );
    }

    const parentItems = await indexItems(zesty, parentModelZuid);
    const map = new Map();
    for (const [trId, item] of parentItems.byTrId) {
      map.set(trId, { zuid: item.meta.ZUID, pathPart: item.web && item.web.pathPart });
    }

    log.info("sync.parents.loaded", { tier: tierKey, parentTier, known: map.size });
    zuidByTrId.set(parentTier, map);
    return map;
  }
  const report = { startedAt: startedAt.toISOString(), dryRun: cfg.dryRun, tiers: {} };

  for (const tierKey of cfg.tiers) {
    const tier = TIERS[tierKey];
    const modelZuid = models.get(tier.zestyModel);

    if (!modelZuid) {
      throw new Error(
        `Zesty model "${tier.zestyModel}" not found on instance ${cfg.zesty.instanceZuid}. ` +
          "Check the model's reference name in the Manager."
      );
    }

    const { records, extras } = await fetchTier(tr, tier);
    const itemIndex = await indexItems(zesty, modelZuid);

    // Zesty enforces required fields on create. Know which they are before
    // building a payload, so a missing one is named rather than guessed at.
    const requiredFields = await requiredFieldsFor(zesty, modelZuid);
    const templateData = await loadSeedTemplate(
      zesty,
      modelZuid,
      (cfg.seedTemplates || {})[tierKey]
    );

    const plan = reconcile({
      tierKey,
      tier,
      trRecords: records,
      extras,
      itemIndex,
      previousHashes: hashesFor(state, tierKey),
      now: startedAt
    });

    const tierMap = new Map();
    for (const [trId, item] of itemIndex.byTrId) {
      tierMap.set(trId, { zuid: item.meta.ZUID, pathPart: item.web && item.web.pathPart });
    }

    const hashes = { ...hashesFor(state, tierKey) };
    const outcome = {
      created: 0,
      refreshed: 0,
      unchanged: plan.unchanged.length,
      skipped: 0,
      conflicts: plan.conflicts,
      orphans: orphansAreMeaningful(tier) ? plan.orphans : [],
      orphansSuppressed: orphansAreMeaningful(tier) ? 0 : plan.orphans.length,
      unlinked: plan.unlinked.length,
      errors: []
    };

    async function writeOne(trId, snapshot, itemZuid) {
      // The snapshot records which Zesty item owns it, so a consumer holding
      // only the file can get back to the CMS entry without a second lookup.
      const known = tierMap.get(trId);
      snapshot.meta.zestyItemZuid = itemZuid || (known && known.zuid) || null;

      try {
        const res = await writeSnapshot(zesty, viewIndex, {
          filename: snapshotPath(tierKey, trId),
          payload: snapshot,
          dryRun: cfg.dryRun
        });
        hashes[trId] = snapshot.meta.hash;
        if (res.action === "updated" || res.action === "would-update") {
          outcome.refreshed++;
        }
        log.debug("sync.snapshot", res);
      } catch (err) {
        outcome.errors.push({ stage: "writeSnapshot", trId, error: err.message });
        log.error("sync.snapshot.failed", { tier: tierKey, trId, error: err.message });
      }
    }

    // --- creates ---------------------------------------------------------
    for (const entry of plan.create) {
      if (!cfg.createMissingItems) {
        outcome.skipped++;
        continue;
      }

      const parentTrId = entry.parentTrIds[0];
      const parent = tier.parentTier
        ? (await parentIndexFor(tierKey)).get(parentTrId)
        : undefined;
      const parentZuid = parent && parent.zuid;

      // A child whose parent is missing is left for the next run rather than
      // created at the root, where it would take a URL that contradicts the
      // catalog's route shape and would have to be moved by hand later.
      if (tier.parentTier && !parentZuid) {
        outcome.skipped++;
        log.warn("sync.parent.missing", { tier: tierKey, trId: entry.trId, parentTrId });
        continue;
      }

      try {
        const res = await createItem(zesty, {
          modelZuid,
          tier,
          trId: entry.trId,
          title: entry.title,
          pathPart: uniquePathPart(entry.title, parent && parent.pathPart, usedPaths),
          parentItemZuid: parentZuid,
          snapshot: entry.snapshot,
          requiredFields,
          templateData,
          dryRun: cfg.dryRun
        });
        if (res.zuid) {
          tierMap.set(entry.trId, { zuid: res.zuid, pathPart: res.pathPart });
        } else if (cfg.dryRun) {
          // A dry run has no real ZUID, but without a placeholder every child
          // tier reports "parent missing" and the plan for the lower tiers is
          // meaningless. Nothing is written, so the stand-in is harmless.
          tierMap.set(entry.trId, { zuid: DRY_RUN_ZUID, pathPart: res.pathPart });
        }
        outcome.created++;
        log.info("sync.item", res);
      } catch (err) {
        outcome.errors.push({ stage: "createItem", trId: entry.trId, error: err.message });
        log.error("sync.item.failed", { tier: tierKey, trId: entry.trId, error: err.message });
        continue;
      }

      await writeOne(entry.trId, entry.snapshot);
    }

    // --- snapshot refreshes ----------------------------------------------
    for (const entry of plan.refresh) {
      await writeOne(entry.trId, entry.snapshot, entry.zuid);
    }

    zuidByTrId.set(tierKey, tierMap);
    state.tiers[tierKey] = {
      hashes,
      lastSyncedAt: startedAt.toISOString(),
      sourceCount: records.length
    };

    outcome.trRecords = records.length;
    outcome.requiredFields = requiredFields;
    outcome.seedTemplate = (cfg.seedTemplates || {})[tierKey] || null;
    report.tiers[tierKey] = outcome;

    log.info("sync.tier.done", {
      tier: tierKey,
      trRecords: records.length,
      created: outcome.created,
      refreshed: outcome.refreshed,
      unchanged: outcome.unchanged,
      skipped: outcome.skipped,
      orphans: outcome.orphans.length,
      conflicts: outcome.conflicts.length,
      errors: outcome.errors.length
    });
  }

  state.lastRun = {
    finishedAt: new Date().toISOString(),
    dryRun: cfg.dryRun,
    tiers: Object.fromEntries(
      Object.entries(report.tiers).map(([k, v]) => [
        k,
        {
          trRecords: v.trRecords,
          created: v.created,
          refreshed: v.refreshed,
          unchanged: v.unchanged,
          orphans: v.orphans.length,
          errors: v.errors.length
        }
      ])
    )
  };

  await writeState(zesty, viewIndex, state, { dryRun: cfg.dryRun });

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt.getTime();
  report.errorCount = Object.values(report.tiers).reduce((n, t) => n + t.errors.length, 0);

  log.info("sync.done", {
    durationMs: report.durationMs,
    errorCount: report.errorCount,
    idField: TR_ID_FIELD
  });

  return report;
}

module.exports = { run };
