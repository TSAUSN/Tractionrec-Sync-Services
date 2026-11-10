"use strict";

const functions = require("@google-cloud/functions-framework");
const { run } = require("./datasets/run");
const { loadCenter } = require("./centers");
const log = require("./logger");

/**
 * HTTP entry point: one run of the dataset sync for one center per request.
 * This service has no schedule of its own; a separate service calls it, once
 * per center. SYNC_TRIGGER_KEY is a cheap second guard beside the function's
 * IAM, so a misconfigured binding cannot turn the endpoint into an open write
 * path into the CMS.
 *
 *   ?center=phoenix                          required: a center in centers.yaml
 *                                            (its secrets: src/centers.js)
 *   &datasets=tr_classes,tr_price_levels     only these datasets
 *   &dry=1                                   plan, write nothing
 */
functions.http("sync", async (req, res) => {
  const expected = process.env.SYNC_TRIGGER_KEY || "";
  if (expected && req.get("X-Sync-Key") !== expected) {
    log.warn("sync.unauthorized", { ip: req.ip });
    res.status(403).json({ error: "forbidden" });
    return;
  }

  const centerId = String(req.query.center || "");
  if (!centerId) {
    res.status(400).json({ error: "?center=<id> is required" });
    return;
  }
  let config;
  try {
    config = await loadCenter(centerId);
  } catch (err) {
    if (err.code === "UNKNOWN_CENTER") {
      log.warn("sync.unknown_center", { center: centerId });
      res.status(404).json({ error: err.message });
      return;
    }
    log.error("sync.failed", { center: centerId, error: err.message });
    res.status(500).json({ center: centerId, error: err.message });
    return;
  }

  const overrides = { center: centerId, config };
  if (req.query.datasets) {
    overrides.datasets = String(req.query.datasets)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  if (req.query.dry !== undefined) {
    overrides.dryRun = req.query.dry === "1" || req.query.dry === "true";
  }

  await log.withContext({ center: centerId }, async () => {
    try {
      const report = await run(overrides);
      // A partial failure still returns 200 with a non-zero errorCount so the
      // report is readable; alerting keys off errorCount, not the status.
      res.status(200).json(report);
    } catch (err) {
      log.error("sync.failed", { error: err.message, stack: err.stack });
      res.status(500).json({ center: centerId, error: err.message });
    }
  });
});

module.exports = { run };
