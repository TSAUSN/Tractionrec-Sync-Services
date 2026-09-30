"use strict";

const { ok } = require("./client");
const { TR_ID_FIELD } = require("../config");
const { buildCreateData, unsatisfiedRequired } = require("../sync/seed");
const log = require("../logger");

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

/** The field names a model marks required. Zesty enforces these on create. */
async function requiredFieldsFor(zesty, modelZuid) {
  const res = ok(await zesty.instance.getModelFields(modelZuid), "getModelFields");
  return (res.data || []).filter((f) => f.required).map((f) => f.name);
}

/**
 * Read an existing item's data to use as placeholder values for required
 * fields. Temporary scaffolding — see src/sync/seed.js for why it exists and
 * how narrowly it applies.
 */
async function loadSeedTemplate(zesty, modelZuid, itemZuid) {
  if (!itemZuid) {
    return null;
  }
  const res = ok(await zesty.instance.getItem(modelZuid, itemZuid), `getItem ${itemZuid}`);
  const data = (res.data && res.data.data) || null;
  if (data) {
    log.warn("zesty.seed.template", {
      modelZuid,
      itemZuid,
      message: "Placeholder values will be copied into required fields. Clear `required` on editorial fields to stop needing this."
    });
  }
  return data;
}

/**
 * Create the Zesty item for a Traction Rec record that has none.
 *
 * Only fields an editor cannot reasonably supply are seeded: the join key, a
 * title, the parent link, whatever Traction Rec genuinely carries, and — only
 * where a required field would otherwise block the create — a placeholder.
 * Updates never touch item fields at all; see docs/sync-flow.md.
 */
async function createItem(zesty, {
  modelZuid,
  tier,
  trId,
  title,
  pathPart,
  parentItemZuid,
  snapshot,
  requiredFields = [],
  templateData = null,
  dryRun
}) {
  const { data, provenance } = buildCreateData({
    tier,
    trId,
    title,
    parentItemZuid,
    snapshot,
    requiredFields,
    templateData
  });

  const missing = unsatisfiedRequired(data, requiredFields);
  if (missing.length) {
    // Fail here rather than at the API, so the message names the fields and
    // the two ways out instead of echoing a validation string.
    throw new Error(
      `cannot create ${trId}: required field(s) ${missing.join(", ")} have no value. ` +
        "Either clear `required` on them in the Manager, or point SEED_TEMPLATE_ITEMS " +
        "at an item that fills them."
    );
  }

  const payload = {
    data,
    web: {
      canonicalTagMode: 1,
      pathPart,
      metaTitle: title,
      metaLinkText: title,
      metaDescription: ""
      // `web.parentZUID` is deliberately NOT set. Verified 2026-09-28: the
      // catalog models are not nested (categories/programs/courses sit at
      // root; `classes` points at the stale `program_categories` pageset) and
      // every hand-authored item lives flat at root — /basketball/,
      // /adaptive-swim-lessons/. The hierarchy is carried by the relational
      // field instead, which is what the custom endpoints query with
      // FIND_IN_SET. Nesting items here would produce URLs unlike any existing
      // one. Opt in per tier with `nestItemsUnderParent` if that changes.
      ,
      ...(tier.nestItemsUnderParent && parentItemZuid
        ? { parentZUID: parentItemZuid }
        : {})
    },
    meta: { contentModelZUID: modelZuid }
  };

  if (dryRun) {
    return { action: "would-create", trId, title, pathPart, provenance };
  }

  const res = ok(await zesty.instance.createItem(modelZuid, payload), `createItem ${trId}`);
  const zuid = res.data && (res.data.ZUID || res.data.zuid);

  // A created item is version 1 and unpublished. Publishing is what puts it on
  // the live domain; without it the URL the snapshot points at does not exist.
  ok(await zesty.instance.publishItem(modelZuid, zuid, 1), `publishItem ${zuid}`);

  return { action: "created", trId, zuid, title, pathPart, provenance };
}

module.exports = { indexModels, indexItems, createItem, requiredFieldsFor, loadSeedTemplate };
