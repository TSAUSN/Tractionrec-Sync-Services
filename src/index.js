"use strict";

const functions = require("@google-cloud/functions-framework");
const { run } = require("./sync/run");
const log = require("./logger");

/**
 * HTTP entry point. Cloud Scheduler calls this on a cron with an OIDC token;
 * SYNC_TRIGGER_KEY is a second, cheap guard so a misconfigured IAM binding
 * cannot turn the endpoint into an open write path into the CMS.
 */
functions.http("sync", async (req, res) => {
  const expected = process.env.SYNC_TRIGGER_KEY || "";
  if (expected && req.get("X-Sync-Key") !== expected) {
    log.warn("sync.unauthorized", { ip: req.ip });
    res.status(403).json({ error: "forbidden" });
    return;
  }

  // Per-request overrides, so a run can be narrowed without a redeploy:
  //   ?tiers=class&dry=1
  const overrides = {};
  if (req.query.tiers) {
    overrides.tiers = String(req.query.tiers).split(",").map((t) => t.trim()).filter(Boolean);
  }
  if (req.query.dry !== undefined) {
    overrides.dryRun = req.query.dry === "1" || req.query.dry === "true";
  }

  try {
    const report = await run(overrides);
    // A partial failure still returns 200 with a non-zero errorCount so the
    // run's own report is readable; alerting keys off errorCount, not status.
    res.status(200).json(report);
  } catch (err) {
    log.error("sync.failed", { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

module.exports = { run };
