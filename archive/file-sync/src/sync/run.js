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
const { linkItem, fileKey } = require("./shape");
const { readState, writeState, hashesFor } = require("./state");
const { writeTierFile, writeDerivedFile, readTierFile } = require("./tier-files");
const { relations, buildChildrenFiles } = require("./children-files");
const { uniquePathPart, collectUsedPaths } = require("./paths");
const log = require("../logger");

/** The item index of a files-only tier: it has no model, so it has no items. */
const NO_ITEMS = Object.freeze({ byTrId: new Map(), duplicates: new Map(), unlinked: [], all: [] });

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
    if (TIERS[key].filesOnly) {
      continue;
    }
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
   * Without this, `--tiers=classes` alone would skip every class: the parent map
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
  const report = { startedAt: startedAt.toISOString(), dryRun: cfg.dryRun, tiers: {}, children: {} };

  /** tierKey -> every row of that tier's file, for the children files. */
  const snapshotsByTier = {};

  for (const tierKey of cfg.tiers) {
    const tier = TIERS[tierKey];
    const modelZuid = tier.filesOnly ? null : models.get(tier.zestyModel);

    if (!tier.filesOnly && !modelZuid) {
      throw new Error(
        `Zesty model "${tier.zestyModel}" not found on instance ${cfg.zesty.instanceZuid}. ` +
          "Check the model's reference name in the Manager."
      );
    }

    const { records, extras } = await fetchTier(tr, tier);
    // A files-only tier (memberships) has no model, so no items to index,
    // create or link: every record goes straight to its file.
    const itemIndex = tier.filesOnly ? NO_ITEMS : await indexItems(zesty, modelZuid);

    // Zesty enforces required fields on create. Know which they are before
    // building a payload, so a missing one is named rather than guessed at.
    const requiredFields = tier.filesOnly ? [] : await requiredFieldsFor(zesty, modelZuid);
    const templateData = tier.filesOnly
      ? null
      : await loadSeedTemplate(zesty, modelZuid, (cfg.seedTemplates || {})[tierKey]);

    // A ledger hash only means "already written" while its file still exists.
    // Without this, a partial reset (`--tiers=courses`) deleted the files but
    // left their hashes, so every record looked unchanged and the files were
    // never recreated.
    const previousHashes = Object.fromEntries(
      Object.entries(hashesFor(state, tierKey)).filter(([trId]) =>
        viewIndex.has(snapshotPath(tierKey, trId))
      )
    );

    const plan = reconcile({
      tierKey,
      tier,
      trRecords: records,
      extras,
      itemIndex,
      previousHashes,
      now: startedAt
    });

    const tierMap = new Map();
    for (const [trId, item] of itemIndex.byTrId) {
      tierMap.set(trId, { zuid: item.meta.ZUID, pathPart: item.web && item.web.pathPart });
    }

    const hashes = { ...hashesFor(state, tierKey) };
    /** Every record's snapshot, collected for the tier file (see tier-files.js). */
    const tierSnapshots = [];
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
      // The snapshot records which Zesty item owns it and the URL that item
      // answers on, so a page holding only the file can link to the CMS page.
      // Existing items were linked in reconcile; a just-created item is linked
      // here from what createItem returned.
      const known = tierMap.get(trId);
      if (!tier.filesOnly && !snapshot.meta.zestyItemZuid) {
        linkItem(snapshot, {
          zuid: itemZuid || (known && known.zuid),
          path: known && known.pathPart ? `/${known.pathPart}/` : null
        });
      }
      tierSnapshots.push(snapshot);

      try {
        const res = await writeSnapshot(zesty, viewIndex, {
          filename: snapshotPath(tierKey, trId),
          payload: snapshot,
          dryRun: cfg.dryRun
        });
        hashes[trId] = fileKey(snapshot);
        // A refresh whose view is missing (after a reset, say) comes back as
        // "created", not "updated". Counting only updates reported 0 written
        // when 212 files had just been rewritten.
        if (res.action !== "unchanged") {
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

    // The tier file is a complete picture, so it needs the records that did not
    // change as well — they never pass through writeOne.
    for (const entry of plan.unchanged) {
      const rebuilt = plan.snapshotsByTrId && plan.snapshotsByTrId[entry.trId];
      if (rebuilt) {
        // already linked to its item and URL in reconcile
        tierSnapshots.push(rebuilt);
      }
    }

    if (tierSnapshots.length) {
      tierSnapshots.sort((a, b) => String(a.meta.tractionrecId).localeCompare(b.meta.tractionrecId));
      await writeTierFile(zesty, viewIndex, state, {
        tierKey,
        snapshots: tierSnapshots,
        dryRun: cfg.dryRun
      });
    }
    snapshotsByTier[tierKey] = tierSnapshots;

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

  // --- parent -> children files (children-files.js) -----------------------
  // After every tier, because each relationship needs both of its tiers. A
  // tier not in this run is read back from its published tier file.
  for (const rel of relations()) {
    if (!cfg.tiers.includes(rel.childTierKey) && !cfg.tiers.includes(rel.parentTierKey)) {
      continue;
    }
    const key = `${rel.parentTierKey}->${rel.childTierKey}`;
    const childRows =
      snapshotsByTier[rel.childTierKey] || (await readTierFile(zesty, viewIndex, rel.childTierKey));
    const parentRows =
      snapshotsByTier[rel.parentTierKey] || (await readTierFile(zesty, viewIndex, rel.parentTierKey));

    if (!childRows || !parentRows) {
      log.warn("sync.children.skipped", {
        relation: key,
        reason: `no rows for ${!childRows ? rel.childTierKey : rel.parentTierKey}; sync that tier first`
      });
      report.children[key] = { skipped: true };
      continue;
    }

    const { files, unparented } = buildChildrenFiles({
      ...rel,
      parentIds: parentRows.map((r) => (r.meta && r.meta.tractionrecId) || r.Id),
      childRows
    });

    const outcome = { files: files.length, written: 0, unchanged: 0, empty: 0, unparented, errors: [] };
    for (const file of files) {
      if (!file.rows.length) {
        outcome.empty++;
      }
      try {
        const res = await writeDerivedFile(zesty, viewIndex, state, {
          filename: file.filename,
          rows: file.rows,
          dryRun: cfg.dryRun
        });
        if (res.action === "unchanged") {
          outcome.unchanged++;
        } else {
          outcome.written++;
        }
      } catch (err) {
        outcome.errors.push({ file: file.filename, error: err.message });
        log.error("sync.children.failed", { file: file.filename, error: err.message });
      }
    }
    report.children[key] = outcome;

    log.info("sync.children.done", {
      relation: key,
      files: outcome.files,
      written: outcome.written,
      unchanged: outcome.unchanged,
      empty: outcome.empty,
      // Children whose parent is not synced (e.g. a course under a program
      // that was skipped). They are in the tier file, but in no parent's file.
      unparented: unparented.length,
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
    ),
    children: Object.fromEntries(
      Object.entries(report.children).map(([k, v]) => [
        k,
        v.skipped
          ? { skipped: true }
          : { files: v.files, written: v.written, unchanged: v.unchanged, empty: v.empty }
      ])
    )
  };

  await writeState(zesty, viewIndex, state, { dryRun: cfg.dryRun });

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt.getTime();
  report.errorCount =
    Object.values(report.tiers).reduce((n, t) => n + t.errors.length, 0) +
    Object.values(report.children).reduce((n, c) => n + ((c.errors && c.errors.length) || 0), 0);

  log.info("sync.done", {
    durationMs: report.durationMs,
    errorCount: report.errorCount,
    idField: TR_ID_FIELD
  });

  return report;
}

module.exports = { run };
