"use strict";

const { TIERS, SNAPSHOT_ROOT } = require("../config");
const { pluck } = require("../tractionrec/fetch-tier");
const { viewPath } = require("../zesty/views");
const { titleFor, hash } = require("./shape");

/**
 * Parent -> children files: `/tractionrec/<parentTier>/<parentId>/<childTier>.json`,
 * a root array of the same row objects as the child tier file.
 *
 *   program_categories/<id>/programs.json   programs tagged into that category
 *   programs/<id>/courses.json              that program's courses
 *   courses/<id>/classes.json               that course's classes
 *
 * The REST shape: a child collection under its parent. The parent's own record
 * is `<parentTier>/<parentId>.json`, so one name is both a file and a folder;
 * verified 2026-10-02 that Zesty serves both and Parsley reads both.
 *
 * They exist so a page can read only its own children instead of filtering a
 * whole tier file. They are DERIVED: built in the same run, from the same rows,
 * as the tier files, which stay the source of truth. Nothing here is ever
 * patched in place.
 *
 * Rules, each of which closes a way for a file to go wrong:
 *
 *   - Every synced parent gets a file, `[]` when it has no children. Otherwise
 *     a course that loses its last class keeps a file listing classes that no
 *     longer exist, and a page cannot tell "no children" from "file missing"
 *     (api.json.get on a 404 is one silent empty pass).
 *   - Every file is rebuilt from the full set of rows on every run. With a
 *     many-to-many link (category <-> program) that is what makes untagging
 *     correct: the program drops out of one category's file and stays in the
 *     other's, with no per-change bookkeeping.
 *   - Rows are copied in full, not as ids. An id list would send every page
 *     back to one fetch per row (test page §6: 71 s for 119 courses).
 *   - Rows are sorted by display name, then Id, so the same members always
 *     produce the same bytes and the same hash.
 *
 * Verified 2026-10-02: Traction Rec's category <-> program link object
 * (TREX1__Program_Category_Tag__c) carries no data of its own, only the two
 * lookups and TREX1__Legacy_Id__c, so a program's row is identical in every
 * category file. If it ever gains a per-link field (display order, "primary"),
 * that field cannot live on the program row and this design has to change.
 */

/** The relationships, read from the tier map: one per tier with a parent. */
function relations() {
  return Object.entries(TIERS)
    .filter(([, tier]) => tier.parentTier)
    .map(([childTierKey, tier]) => ({ childTierKey, parentTierKey: tier.parentTier }));
}

/**
 * A row's parent ids. An array for the junction-backed tier (Program, whose
 * categories the sync attaches under `relationKey`); a single lookup otherwise.
 */
function parentIdsOf(childTierKey, row) {
  const tier = TIERS[childTierKey];
  if (tier.relationKey) {
    const ids = row[tier.relationKey];
    return Array.isArray(ids) ? ids : [];
  }
  const id = tier.parentVia && tier.parentVia.lookup ? pluck(row, tier.parentVia.lookup) : null;
  return id ? [id] : [];
}

function childrenPath(parentTierKey, parentId, childTierKey) {
  return viewPath(`${SNAPSHOT_ROOT}/${parentTierKey}/${parentId}/${childTierKey}.json`);
}

function rowId(row) {
  return (row.meta && row.meta.tractionrecId) || row.Id;
}

/**
 * Pure: every children file for one relationship.
 *
 * `parentIds` is the full set of synced parents (each gets a file, empty or
 * not); `childRows` is the full child tier. Children whose parent is not in
 * the set are returned as `unparented` rather than silently dropped.
 */
function buildChildrenFiles({ childTierKey, parentTierKey, parentIds, childRows }) {
  const tier = TIERS[childTierKey];
  const byParent = new Map([...new Set(parentIds)].map((id) => [id, []]));
  const unparented = [];

  for (const row of childRows) {
    const parents = parentIdsOf(childTierKey, row);
    let placed = false;
    for (const parentId of new Set(parents)) {
      const list = byParent.get(parentId);
      if (list) {
        list.push(row);
        placed = true;
      }
    }
    if (!placed) {
      unparented.push({ id: rowId(row), parents });
    }
  }

  const sortKey = (row) => titleFor(tier, row).toLowerCase();
  const files = [...byParent.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([parentId, rows]) => ({
      filename: childrenPath(parentTierKey, parentId, childTierKey),
      parentId,
      rows: rows.sort(
        (a, b) => sortKey(a).localeCompare(sortKey(b)) || String(rowId(a)).localeCompare(rowId(b))
      )
    }));

  return { files, unparented };
}

/**
 * The content hash of a derived file (tier or children). It covers each row's
 * own content hash, its Zesty item and URL, and the order — but not `meta.syncedAt`,
 * which changes every run and would otherwise rewrite every file every run.
 */
function derivedHash(rows) {
  return hash(
    rows.map((r) => [
      rowId(r),
      r.meta && r.meta.hash,
      r.meta && r.meta.zestyItemZuid,
      r.meta && r.meta.zestyPath
    ])
  );
}

module.exports = { relations, parentIdsOf, childrenPath, buildChildrenFiles, derivedHash };
