"use strict";

const { ok } = require("./client");
const log = require("../logger");

/** Every tr_* dataset item and catalog page item carries the record's Salesforce Id here. */
const TR_ID_FIELD = "tractionrec_id";

/** Resolve a model reference name ("categories") to its ZUID, once per run. */
async function indexModels(zesty) {
  const res = ok(await zesty.instance.getModels(), "getModels");
  const byName = new Map();
  for (const model of res.data || []) {
    byName.set(model.name, model.ZUID);
    if (model.referenceName) {
      byName.set(model.referenceName, model.ZUID);
    }
  }
  return byName;
}

/**
 * Index a model's items by their Traction Rec Id.
 *
 * `_active: 0` returns drafts as well as published items. That matters: an
 * item created by a previous run but never published still owns its TR Id,
 * and skipping it would create a duplicate on the next pass.
 */
async function indexItems(zesty, modelZuid) {
  const res = ok(await zesty.instance.getItems(modelZuid, { _active: 0, limit: 5000, page: 1 }), "getItems");

  const byTrId = new Map();
  const duplicates = new Map();
  const unlinked = [];

  for (const item of res.data || []) {
    const trId = item.data && item.data[TR_ID_FIELD];
    if (!trId) {
      unlinked.push(item);
      continue;
    }
    if (byTrId.has(trId)) {
      const list = duplicates.get(trId) || [byTrId.get(trId)];
      list.push(item);
      duplicates.set(trId, list);
      continue;
    }
    byTrId.set(trId, item);
  }

  log.info("zesty.items.indexed", {
    modelZuid,
    linked: byTrId.size,
    unlinked: unlinked.length,
    duplicates: duplicates.size
  });

  return { byTrId, duplicates, unlinked, all: res.data || [] };
}

module.exports = { indexModels, indexItems, TR_ID_FIELD };
