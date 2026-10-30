"use strict";

const { STATE_FILE } = require("../config");
const { ok } = require("../zesty/client");
const { writeSnapshot } = require("../zesty/views");
const log = require("../logger");

/**
 * The hash ledger: `{ <tractionRecId>: "sha256:..." }` per tier, plus the last
 * run's summary.
 *
 * It lives in the instance as one more ajax-json view rather than in Firestore
 * or GCS, which keeps the service to two dependencies (Traction Rec, Zesty)
 * and makes the state inspectable with a browser. It holds ids, hashes and
 * counts — nothing secret. If it is ever lost, the next run simply rewrites
 * every snapshot once and carries on.
 */
const EMPTY = { version: 1, tiers: {}, lastRun: null };

async function readState(zesty, viewIndex) {
  const entry = viewIndex.get(STATE_FILE);
  if (!entry) {
    log.info("state.absent", { file: STATE_FILE });
    return { ...EMPTY };
  }

  try {
    const res = ok(await zesty.instance.getView(entry.zuid), "getView state");
    const code = res.data && res.data.code;
    const parsed = code ? JSON.parse(code) : null;
    if (parsed && parsed.tiers) {
      return parsed;
    }
  } catch (err) {
    // A corrupt ledger must not stop a sync. Losing it costs one redundant
    // full write, which is cheaper than a failed run.
    log.warn("state.unreadable", { file: STATE_FILE, error: err.message });
  }

  return { ...EMPTY };
}

async function writeState(zesty, viewIndex, state, { dryRun }) {
  return writeSnapshot(zesty, viewIndex, {
    filename: STATE_FILE,
    payload: state,
    dryRun
  });
}

function hashesFor(state, tierKey) {
  return (state.tiers && state.tiers[tierKey] && state.tiers[tierKey].hashes) || {};
}

module.exports = { readState, writeState, hashesFor, EMPTY };
