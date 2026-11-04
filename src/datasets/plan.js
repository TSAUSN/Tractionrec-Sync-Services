"use strict";

/**
 * One dataset's plan: for each record, the item data it should have, and
 * whether that means a create, an update, or nothing. Pure — no API calls —
 * so it is unit-tested directly.
 *
 * Two kinds of record come in:
 *   records    the published set (Traction Rec's gate): active = 1
 *   inactive   ids the sync knows (an item, or a catalog page item) that are
 *              NOT in the published set, each with its current Traction Rec
 *              record when it still exists (re-read without the gate) or null
 *              when it was removed. These become active = 0 with a reason.
 * A published record whose required parent can't be resolved is also written
 * as active = 0, with the parent as the reason. Nothing is ever deleted or
 * skipped: the item stays, the site hides it, and it flips back to
 * active = 1 when Traction Rec publishes it again.
 *
 * Relations are resolved here, because Zesty resolves nothing: a one_to_one
 * accepts any string, a ZUID that does not exist included (probed).
 * An inactive row whose parent can't be resolved keeps the
 * relation it had; it is never written with a guess.
 *
 * Change detection: `sync_hash` on the item is the hash of every other field
 * the sync writes, relation ZUIDs and `active` included, so a re-created
 * parent rewrites its children and a record leaving the set is written once.
 * `synced_at` is outside the hash. Equal hash, no write: each save is a new
 * item version, so an unchanged run writes nothing.
 */

const { hash } = require("./hash");
const { convert } = require("./values");
const { DERIVED_REASON } = require("./definitions");

const OUTSIDE_HASH = new Set(["sync_hash", "synced_at"]);
const REMOVED_REASON = "Removed from Traction Rec";

/** The hash a record's data is stored under. */
function dataHash(data) {
  const hashed = {};
  for (const [k, v] of Object.entries(data)) {
    if (!OUTSIDE_HASH.has(k)) {
      hashed[k] = v;
    }
  }
  return hash(hashed);
}

/**
 * @param ds        the dataset definition (definitions.js)
 * @param records   its published Traction Rec records
 * @param inactive  Map(trId -> record | null): known ids outside the published
 *                  set (see above)
 * @param tr        everything fetched (relations read junction extras from it)
 * @param types     Map(fieldName -> Zesty datatype), from schema.js
 * @param items     indexItems() result for the dataset's model
 * @param zuids     datasetKey -> Map(trId -> item ZUID), current for this run
 * @param pages     pageModel -> Map(trId -> page item ZUID)
 */
function planDataset({ ds, records, inactive = new Map(), tr, types, items, zuids, pages, now = new Date() }) {
  const plan = {
    create: [],
    update: [],
    unchanged: [],
    deactivated: [],
    reactivated: [],
    unresolved: [],
    warnings: [],
    duplicates: []
  };
  const syncedAt = convert("datetime", now.toISOString()).value;

  // Raw values from a Traction Rec record, relations resolved. `reason` is set
  // when a required relation can't be resolved.
  const fromRecord = (record, item) => {
    const trId = record.Id;
    const raw = {
      tractionrec_id: trId,
      name: String(ds.name(record) || trId).trim(),
      last_modified_date: record.LastModifiedDate,
      system_modstamp: record.SystemModstamp
    };
    for (const [field, get] of Object.entries(ds.fields)) {
      raw[field] = get(record);
    }
    let reason = null;
    for (const [field, rel] of Object.entries(ds.relations)) {
      if (rel.pageModel) {
        // The Zesty page for this record (pages.js creates it before the plan).
        raw[field] = (pages.get(rel.pageModel) || new Map()).get(trId) || null;
        continue;
      }
      const ids = [...new Set(rel.ids(record, tr).filter(Boolean))];
      const map = zuids.get(rel.dataset) || new Map();
      const resolved = ids.map((id) => map.get(id)).filter(Boolean);
      const missing = ids.filter((id) => !map.has(id));
      if (missing.length || (rel.required && !ids.length)) {
        if (rel.required) {
          reason = reason || (ids.length ? `Its ${field} (${missing.join(", ")}) is not in ${rel.dataset}` : `No ${field} in Traction Rec`);
          // Keep what the item had rather than writing a guess.
          raw[field] = item && item.data ? item.data[field] ?? null : null;
          continue;
        }
        plan.warnings.push({ trId, field, warning: `${missing.join(", ")} not in ${rel.dataset}; left empty` });
      }
      raw[field] = types.get(field) === "one_to_many" ? resolved : resolved[0] || null;
    }
    return { raw, reason };
  };

  // Raw values for a removed record: what its item holds now.
  const fromItem = (item) => {
    const raw = {};
    for (const field of types.keys()) {
      if (!OUTSIDE_HASH.has(field)) {
        raw[field] = item.data ? item.data[field] ?? null : null;
      }
    }
    return raw;
  };

  const add = (trId, raw, active, reason) => {
    raw.active = active ? 1 : 0;
    raw.inactive_reason = active ? null : reason;
    const data = {};
    for (const [field, value] of Object.entries(raw)) {
      const datatype = types.get(field);
      if (!datatype) {
        // schema.js already refused a run with a missing field; this only
        // guards a definition that fills a field the live model lacks.
        throw new Error(`${ds.key}.${field}: no such field on the model`);
      }
      const { value: stored, warning } = convert(datatype, value);
      if (warning) {
        plan.warnings.push({ trId, field, warning });
      }
      data[field] = stored;
    }
    data.sync_hash = dataHash(data);
    data.synced_at = syncedAt;

    const item = items.byTrId.get(trId);
    const name = String(data.name || trId);
    // null = unknown: an item written before the active field existed. That
    // field reads back as 0 there (Zesty stores an unset yes_no as 0), but a
    // genuinely inactive row always carries a reason.
    const prev = item && item.data ? item.data : null;
    const wasActive = !prev
      ? null
      : String(prev.active) === "1"
        ? true
        : prev.inactive_reason
          ? false
          : null;
    if (!active && wasActive !== false) {
      plan.deactivated.push({ trId, name, reason });
    }
    if (active && wasActive === false) {
      plan.reactivated.push({ trId, name });
    }
    if (!item) {
      plan.create.push({ trId, name, data, active });
    } else if (item.data && item.data.sync_hash === data.sync_hash) {
      plan.unchanged.push({ trId, zuid: item.meta.ZUID, active });
    } else {
      // A rename is propagated to the record's Zesty page (pages.js).
      const renamed = !!(item.data && item.data.name && item.data.name !== data.name);
      plan.update.push({ trId, name, data, zuid: item.meta.ZUID, item, active, renamed });
    }
  };

  // Published records.
  const seen = new Set();
  for (const record of records) {
    seen.add(record.Id);
    const item = items.byTrId.get(record.Id);
    const { raw, reason } = fromRecord(record, item);
    add(record.Id, raw, !reason, reason);
  }

  // Known records outside the published set.
  for (const [trId, record] of inactive) {
    if (seen.has(trId)) {
      continue;
    }
    seen.add(trId);
    const item = items.byTrId.get(trId);
    if (record) {
      const { raw, reason } = fromRecord(record, item);
      const why = (ds.gateReason && ds.gateReason(record)) || reason || "Not published online in Traction Rec";
      add(trId, raw, false, why);
    } else if (item) {
      add(trId, fromItem(item), false, ds.derived ? DERIVED_REASON : REMOVED_REASON);
    } else {
      // A page item whose record no longer exists in Traction Rec: nothing to
      // build a row from.
      plan.unresolved.push({ trId, reason: "Page item's record is not in Traction Rec" });
    }
  }

  for (const [trId, list] of items.duplicates) {
    plan.duplicates.push({ trId, zuids: list.map((i) => i.meta.ZUID) });
  }
  return plan;
}

module.exports = { planDataset, dataHash, REMOVED_REASON };
