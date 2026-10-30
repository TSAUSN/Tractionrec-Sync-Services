"use strict";

const { buildSnapshot, titleFor, slugify, linkItem, fileKey } = require("./shape");
const { TR_ID_FIELD } = require("../config");

/**
 * The whole decision table, as a pure function. No network, no SDK — hand it
 * records and an item index and it tells you what should happen. This is the
 * piece worth testing, and test/reconcile.test.js does.
 *
 *   Traction Rec record  | Zesty item            | Outcome
 *   ---------------------+-----------------------+--------------------------
 *   present              | none                  | CREATE item + snapshot
 *   present              | one, snapshot stale   | REFRESH snapshot only
 *   present              | one, snapshot current | NOTHING (no version churn)
 *   present              | two or more           | SKIP, report as a conflict
 *   absent               | present, has TR id    | ORPHAN — report, never delete
 *   absent               | present, no TR id     | UNLINKED — hands off entirely
 *
 * A `filesOnly` tier (memberships) has no Zesty model, so only the snapshot
 * half applies: REFRESH when the file is stale, NOTHING when it is current.
 *
 * Two rules are deliberate and load-bearing:
 *
 *   - Deletion never happens. A class that vanishes from Traction Rec between
 *     seasons is normal, and its Zesty item may carry hand-written copy and an
 *     indexed URL. Removing that is a decision for a person, not a cron.
 *
 *   - An existing item's content fields are never written. The item is the
 *     CMS-editable surface; the snapshot is the Traction Rec surface. If this
 *     function ever starts updating item fields, every sync silently reverts
 *     whatever an editor changed since the last run.
 */
function reconcile({ tierKey, tier, trRecords, extras = {}, itemIndex, previousHashes = {}, now = new Date() }) {
  const result = {
    tier: tierKey,
    create: [],
    refresh: [],
    unchanged: [],
    conflicts: [],
    orphans: [],
    unlinked: [],
    /** Every snapshot built this pass, so the tier file can include unchanged rows. */
    snapshotsByTrId: {}
  };

  const seenTrIds = new Set();

  for (const record of trRecords) {
    const trId = record.Id;
    seenTrIds.add(trId);

    if (itemIndex.duplicates.has(trId)) {
      result.conflicts.push({
        trId,
        zuids: itemIndex.duplicates.get(trId).map((i) => i.meta.ZUID)
      });
      continue;
    }

    const snapshot = buildSnapshot({ tierKey, tier, record, extras, now });
    result.snapshotsByTrId[trId] = snapshot;

    // A files-only tier has no Zesty model: the file is the whole output, so
    // there is never an item to create or link.
    if (tier.filesOnly) {
      if (previousHashes[trId] === fileKey(snapshot)) {
        result.unchanged.push({ trId, zuid: null });
      } else {
        result.refresh.push({ trId, zuid: null, snapshot });
      }
      continue;
    }

    const title = titleFor(tier, record);
    const item = itemIndex.byTrId.get(trId);

    if (!item) {
      result.create.push({
        trId,
        title,
        pathPart: slugify(title),
        parentTrIds: tier.relationKey ? snapshot[tier.relationKey] || [] : [],
        snapshot
      });
      continue;
    }

    linkItem(snapshot, { zuid: item.meta.ZUID, path: item.web && item.web.path });

    // The key covers the record's values and the item/URL it links to, not the
    // time it was read, so an unchanged record produces no write at all.
    if (previousHashes[trId] === fileKey(snapshot)) {
      result.unchanged.push({ trId, zuid: item.meta.ZUID });
      continue;
    }

    result.refresh.push({ trId, zuid: item.meta.ZUID, snapshot });
  }

  for (const [trId, item] of itemIndex.byTrId) {
    if (!seenTrIds.has(trId)) {
      result.orphans.push({
        trId,
        zuid: item.meta.ZUID,
        title: (item.data && item.data[tier.zestyTitleField]) || item.web?.metaTitle || ""
      });
    }
  }

  for (const item of itemIndex.unlinked) {
    result.unlinked.push({
      zuid: item.meta.ZUID,
      title: (item.data && item.data[tier.zestyTitleField]) || item.web?.metaTitle || ""
    });
  }

  return result;
}

/**
 * An orphan is only meaningful when the tier was fetched in full. The class
 * tier filters on Traction Rec's publishing gate, so a class that merely
 * stopped being publishable would look identical to one that was deleted.
 * Guard against reporting the whole back-catalogue as orphaned every season.
 */
function orphansAreMeaningful(tier) {
  return !tier.where;
}

module.exports = { reconcile, orphansAreMeaningful, TR_ID_FIELD };
