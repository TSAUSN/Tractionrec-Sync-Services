"use strict";

const functions = require("@google-cloud/functions-framework");
const { run } = require("./datasets/run");
const log = require("./logger");

/**
 * HTTP entry point: one run of the dataset sync per request. This service has
 * no schedule of its own; a separate service calls it. SYNC_TRIGGER_KEY is a
 * cheap second guard beside the function's IAM, so a misconfigured binding
 * cannot turn the endpoint into an open write path into the CMS.
 *
 * Per-request overrides, so a run can be narrowed without a redeploy:
 *   ?datasets=tr_classes,tr_price_levels&dry=1
 */
functions.http("sync", async (req, res) => {
  const expected = process.env.SYNC_TRIGGER_KEY || "";
  if (expected && req.get("X-Sync-Key") !== expected) {
    log.warn("sync.unauthorized", { ip: req.ip });
    res.status(403).json({ error: "forbidden" });
    return;
  }

  const overrides = {};
  if (req.query.datasets) {
    overrides.datasets = String(req.query.datasets)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  if (req.query.dry !== undefined) {
    overrides.dryRun = req.query.dry === "1" || req.query.dry === "true";
  }

  try {
    const report = await run(overrides);
    // A partial failure still returns 200 with a non-zero errorCount so the
    // report is readable; alerting keys off errorCount, not the status.
    res.status(200).json(report);
  } catch (err) {
    log.error("sync.failed", { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

module.exports = { run };
