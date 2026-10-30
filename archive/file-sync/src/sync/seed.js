"use strict";

const { TR_ID_FIELD } = require("../config");

/**
 * Build the `data` object for a NEW Zesty item.
 *
 * Three sources, in descending precedence:
 *
 *   1. **Identity** — the join key, the title, the parent link. The service
 *      owns these; nothing overrides them.
 *   2. **Traction Rec** — fields the tier declares in `zestyFieldsFromTr`,
 *      where a Zesty field and a Traction Rec field genuinely mean the same
 *      thing. Real data beats a placeholder every time.
 *   3. **A seed template** — values copied from an existing hand-made item,
 *      used ONLY to satisfy fields the model marks required that neither of
 *      the above filled.
 *
 * Source 3 is scaffolding, not architecture. Zesty enforces `required` on
 * create and the service cannot invent a hero image, so without it no item can
 * be created at all. It is deliberately narrow — required fields only, never
 * an optional one — so that the machine-written values are confined to the
 * smallest possible surface and are obvious when an editor opens the item.
 *
 * The real fix is clearing `required` on editorial fields. See
 * docs/sync-flow.md §7.
 */
function buildCreateData({
  tier,
  trId,
  title,
  parentItemZuid,
  snapshot,
  requiredFields = [],
  templateData = null
}) {
  const data = { [TR_ID_FIELD]: trId };
  const provenance = { identity: [TR_ID_FIELD], tractionrec: [], template: [] };

  // 1. identity
  if (tier.zestyTitleField) {
    data[tier.zestyTitleField] = title;
    provenance.identity.push(tier.zestyTitleField);
  }
  if (tier.zestyParentField && parentItemZuid) {
    data[tier.zestyParentField] = parentItemZuid;
    provenance.identity.push(tier.zestyParentField);
  }

  // 2. Traction Rec, where the two models agree on meaning
  // Salesforce's fields are the snapshot's root keys (see buildSnapshot).
  const trData = snapshot || {};
  for (const [zestyField, source] of Object.entries(tier.zestyFieldsFromTr || {})) {
    const value = typeof source === "function" ? source(trData, snapshot) : trData[source];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    data[zestyField] = value;
    provenance.tractionrec.push(zestyField);
  }

  // 3. template, for required fields still unset
  if (templateData) {
    for (const field of requiredFields) {
      if (data[field] !== undefined && data[field] !== null && data[field] !== "") {
        continue;
      }
      const fallback = templateData[field];
      if (fallback === undefined || fallback === null || fallback === "") {
        continue;
      }
      data[field] = fallback;
      provenance.template.push(field);
    }
  }

  return { data, provenance };
}

/** Required fields still unset after seeding — these are what a create fails on. */
function unsatisfiedRequired(data, requiredFields = []) {
  return requiredFields.filter(
    (f) => data[f] === undefined || data[f] === null || data[f] === ""
  );
}

module.exports = { buildCreateData, unsatisfiedRequired };
