"use strict";

const { SNAPSHOT_ROOT } = require("../config");
const { ok } = require("../zesty/client");
const { writeSnapshot, viewPath } = require("../zesty/views");
const { derivedHash } = require("./children-files");
const log = require("../logger");

/**
 * Publish one file per tier: `/tractionrec/<tier>.json`, a root array of the
 * same objects the per-item snapshots contain.
 *
 * This is what makes the relationship answerable in one request. Each record
 * already carries its own parent — `TREX1__Program__c` on a Course,
 * `TREX1__cso_Course_Session__r.TREX1__Course__c` on a Class — so a consumer
 * filters the array and needs no index, no per-parent file, and no parent
 * field on the Zesty item:
 *
 *     rows.filter((r) => r.TREX1__Program__c === programTrId)
 *
 * Publishing one file per record is what made that need 119 requests instead
 * of one. The whole catalog is ~49 KB gzipped across four files (measured 2026-09-30).
 *
 * Parsley reads the same file server-side, because each row's Salesforce
 * fields sit at its root (see buildSnapshot):
 *
 *     each api.json.get(<full url>/courses.json) as c
 *       if {c.TREX1__Program__c} == (<program TR id>)  ->  c.Name
 *
 * The limit is one level: anything nested — `meta`, Program's category array,
 * `prices`, and Class's `__r` objects — is readable by JavaScript only.
 * Class's parent Course lives inside `TREX1__cso_Course_Session__r`, so the
 * course -> class relationship cannot be filtered in Parsley from classes.json.
 *
 * For a page that wants only its own children, the parent -> children files
 * (children-files.js) are derived from these same rows.
 */
function tierPath(tierKey) {
  return viewPath(`${SNAPSHOT_ROOT}/${tierKey}.json`);
}

/**
 * Write a derived file (tier or children) only when its content changed.
 *
 * Its hash is kept in the state ledger under `files`. A matching hash counts
 * only while the file still exists, so a reset (or a hand-deleted view) is
 * repaired by the next run instead of being trusted forever.
 */
async function writeDerivedFile(zesty, viewIndex, state, { filename, rows, dryRun }) {
  const digest = derivedHash(rows);
  state.files = state.files || {};

  if (state.files[filename] === digest && viewIndex.has(filename)) {
    return { action: "unchanged", filename };
  }

  const res = await writeSnapshot(zesty, viewIndex, { filename, payload: rows, dryRun });
  if (!dryRun) {
    state.files[filename] = digest;
  }
  return res;
}

async function writeTierFile(zesty, viewIndex, state, { tierKey, snapshots, dryRun }) {
  const filename = tierPath(tierKey);
  const res = await writeDerivedFile(zesty, viewIndex, state, { filename, rows: snapshots, dryRun });

  log.info("sync.tierfile", {
    tier: tierKey,
    file: filename,
    rows: snapshots.length,
    bytes: JSON.stringify(snapshots).length,
    action: res.action
  });

  return res;
}

/**
 * A tier's rows as last published, for a run that does not include that tier.
 * `--tiers=classes` still has to rebuild the course -> classes files, and needs
 * every course to do it (each gets a file, empty or not).
 */
async function readTierFile(zesty, viewIndex, tierKey) {
  const entry = viewIndex.get(tierPath(tierKey));
  if (!entry) {
    return null;
  }
  const res = ok(await zesty.instance.getView(entry.zuid), `getView ${tierPath(tierKey)}`);
  const rows = JSON.parse((res.data && res.data.code) || "null");
  return Array.isArray(rows) ? rows : null;
}

module.exports = { writeTierFile, writeDerivedFile, readTierFile, tierPath };
