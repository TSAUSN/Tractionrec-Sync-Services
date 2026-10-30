"use strict";

/**
 * Everything the sync needs from Traction Rec, behind one small interface — a
 * "source" — so the scenario tests can hand it hand-written data instead
 * (test/scenarios/):
 *
 *   source.fetchAll()               the published set: the six tiers through
 *                                   their gates (TIERS, src/config.js), the
 *                                   price levels, schedules and Products
 *   source.fetchByIds(tier, ids)    Map(id -> record) for records that LEFT
 *                                   the published set: re-read without the
 *                                   gate, so their current values and the
 *                                   reason can be stored. A missing id is a
 *                                   record removed from Traction Rec.
 *
 * The gate is re-read in full on every run, never incrementally: the class
 * gate is a time-based formula that changes without the record being
 * modified (src/config.js).
 */

const { TIERS } = require("../config");
const { fetchTier, pluck } = require("../tractionrec/fetch-tier");
const log = require("../logger");

const MODSTAMPS = ["LastModifiedDate", "SystemModstamp"];
const PRODUCT_FIELDS = ["Id", "Name", "TREX1__Price_Description__c", ...MODSTAMPS];
const TIER_KEYS = ["program_categories", "programs", "courses", "classes", "membership_categories", "membership_types"];

const withModstamps = (fields) => [...new Set([...fields, ...MODSTAMPS])];

/** A tier as the file sync defines it, with modstamps added to its price queries. */
function datasetTier(tier) {
  if (!tier.priceJoin) {
    return tier;
  }
  const join = { ...tier.priceJoin, fields: withModstamps(tier.priceJoin.fields) };
  if (join.schedules) {
    join.schedules = { ...join.schedules, fields: withModstamps(join.schedules.fields) };
  }
  return { ...tier, priceJoin: join };
}

/** `SELECT … WHERE Id IN (…)`, chunked: SOQL has a statement-length ceiling. */
async function queryByIds(client, object, fields, ids) {
  const CHUNK = 200;
  const rows = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const inList = ids.slice(i, i + CHUNK).map((id) => `'${id}'`).join(",");
    rows.push(...(await client.query(`SELECT ${fields.join(", ")} FROM ${object} WHERE Id IN (${inList})`)));
  }
  return rows;
}

/** Unique by Id, in first-seen order. */
function uniqueById(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (row && row.Id && !seen.has(row.Id)) {
      seen.set(row.Id, row);
    }
  }
  return [...seen.values()];
}

async function fetchAll(client) {
  const tr = {};
  for (const key of TIER_KEYS) {
    tr[key] = await fetchTier(client, datasetTier(TIERS[key]));
  }

  // Price levels and schedules arrive grouped by product / level; a level
  // shared by several classes is one record (64 classes share 50 levels).
  const levelMaps = [tr.classes.extras.priceLevelsByProduct, tr.membership_types.extras.priceLevelsByProduct];
  tr.priceLevels = uniqueById(levelMaps.flatMap((m) => (m ? [...m.values()].flat() : [])));
  tr.billingSchedules = uniqueById(
    [...(tr.membership_types.extras.schedulesByLevel?.values() || [])].flat()
  );

  // Products: every one a synced class or membership type points at.
  const productIds = [
    ...new Set(
      [
        ...tr.classes.records.map((r) => pluck(r, TIERS.classes.priceJoin.productPath)),
        ...tr.membership_types.records.map((r) => pluck(r, TIERS.membership_types.priceJoin.productPath))
      ].filter(Boolean)
    )
  ];
  tr.products = await queryByIds(client, "TREX1__Product__c", PRODUCT_FIELDS, productIds);

  log.info("datasets.fetched", {
    ...Object.fromEntries(TIER_KEYS.map((k) => [k, tr[k].records.length])),
    products: tr.products.length,
    priceLevels: tr.priceLevels.length,
    billingSchedules: tr.billingSchedules.length
  });
  return tr;
}

/** Records of a tier by Id, without its gate. Map(id -> record). */
async function fetchByIds(client, tierKey, ids) {
  const tier = TIERS[tierKey];
  const found = new Map();
  if (!ids.length) {
    return found;
  }
  for (const row of await queryByIds(client, tier.trObject, tier.trFields, ids)) {
    found.set(row.Id, row);
  }
  log.info("tractionrec.refetched", { tier: tierKey, asked: ids.length, found: found.size });
  return found;
}

/** The real Traction Rec, through the read-only client. */
function tractionRecSource(client) {
  return {
    fetchAll: () => fetchAll(client),
    fetchByIds: (tierKey, ids) => fetchByIds(client, tierKey, ids)
  };
}

module.exports = { fetchAll, fetchByIds, tractionRecSource, datasetTier, uniqueById };
