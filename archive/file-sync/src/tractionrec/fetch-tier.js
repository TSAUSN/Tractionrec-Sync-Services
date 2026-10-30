"use strict";

const log = require("../logger");

/** Salesforce returns nested lookups as objects; read a dotted path safely. */
function pluck(record, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), record);
}

/**
 * Fetch one tier's records, plus whatever it takes to know each record's
 * parent. Returns records in Salesforce's own shape — flattening happens in
 * `shape.js`, so a raw record stays inspectable in a dry run.
 */
async function fetchTier(client, tier) {
  const soql =
    `SELECT ${tier.trFields.join(", ")} FROM ${tier.trObject}` +
    (tier.where ? ` WHERE ${tier.where}` : "");

  const records = await client.query(soql);
  log.info("tractionrec.fetched", { object: tier.trObject, count: records.length });

  const extras = {};

  // Category <-> Program is a junction, so the parent link needs its own query.
  if (tier.parentVia && tier.parentVia.junction) {
    const { junction, childField, parentField } = tier.parentVia;
    const rows = await client.query(`SELECT ${childField}, ${parentField} FROM ${junction}`);
    extras.parentByChild = new Map();
    for (const row of rows) {
      const child = row[childField];
      const parent = row[parentField];
      if (!child || !parent) {
        continue;
      }
      // The schema permits many-to-many; the data does not currently exercise
      // it (no program is tagged to more than one category). Keep every tag so
      // a second one shows up as data rather than as a silent truncation.
      const list = extras.parentByChild.get(child) || [];
      list.push(parent);
      extras.parentByChild.set(child, list);
    }
    log.info("tractionrec.junction.fetched", { junction, rows: rows.length });
  }

  // Price lives two hops away: the record's Product -> Price Level. On a class
  // it is Course Option's Product that is authoritative — Course Session's is a
  // per-facility "<Facility> Free Product" placeholder carrying no price.
  if (tier.priceJoin) {
    const join = tier.priceJoin;
    const productIds = [
      ...new Set(records.map((r) => pluck(r, join.productPath)).filter(Boolean))
    ];

    extras.priceLevelsByProduct = groupBy(
      await queryIn(client, join.object, join.fields, join.productField, productIds),
      join.productField
    );

    // Memberships go one hop further, to the instalment plan: an Autopay
    // membership's monthly amount exists only on its Planned Billing Schedule.
    if (join.schedules) {
      const levelIds = [...extras.priceLevelsByProduct.values()].flat().map((l) => l.Id);
      extras.schedulesByLevel = groupBy(
        await queryIn(client, join.schedules.object, join.schedules.fields, join.schedules.levelField, levelIds),
        join.schedules.levelField
      );
    }

    log.info("tractionrec.prices.fetched", {
      products: productIds.length,
      priced: extras.priceLevelsByProduct.size,
      schedules: extras.schedulesByLevel ? extras.schedulesByLevel.size : undefined
    });
  }

  return { records, extras };
}

/** `SELECT fields FROM object WHERE field IN (ids)`, chunked: SOQL has a statement-length ceiling. */
async function queryIn(client, object, fields, field, ids) {
  const CHUNK = 200;
  const rows = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const inList = ids.slice(i, i + CHUNK).map((id) => `'${id}'`).join(",");
    rows.push(...(await client.query(`SELECT ${fields.join(", ")} FROM ${object} WHERE ${field} IN (${inList})`)));
  }
  return rows;
}

function groupBy(rows, field) {
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row[field]) || [];
    list.push(row);
    map.set(row[field], list);
  }
  return map;
}

module.exports = { fetchTier, pluck };
