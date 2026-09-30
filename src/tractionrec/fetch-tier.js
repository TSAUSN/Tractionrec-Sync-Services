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
  // A trFields entry is either a SOQL path or a [path, outputKey] pair.
  const paths = tier.trFields.map((f) => (Array.isArray(f) ? f[0] : f));
  const soql =
    `SELECT ${paths.join(", ")} FROM ${tier.trObject}` +
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

  // Price lives two hops from the class junction: Course Option -> Product ->
  // Price Level. Course Option's Product is authoritative — Course Session's
  // is a per-facility "<Facility> Free Product" placeholder carrying no price.
  if (tier.priceJoin) {
    const productIds = [
      ...new Set(
        records.map((r) => pluck(r, "TREX1__Course_Option__r.TREX1__Product__c")).filter(Boolean)
      )
    ];

    extras.priceLevelsByProduct = new Map();

    // SOQL has a statement-length ceiling; chunk the IN list.
    const CHUNK = 200;
    for (let i = 0; i < productIds.length; i += CHUNK) {
      const chunk = productIds.slice(i, i + CHUNK);
      const inList = chunk.map((id) => `'${id}'`).join(",");
      const levels = await client.query(
        `SELECT ${tier.priceJoin.fields.join(", ")} FROM ${tier.priceJoin.object} ` +
          `WHERE ${tier.priceJoin.productField} IN (${inList})`
      );
      for (const lvl of levels) {
        const pid = lvl[tier.priceJoin.productField];
        const list = extras.priceLevelsByProduct.get(pid) || [];
        list.push(lvl);
        extras.priceLevelsByProduct.set(pid, list);
      }
    }

    log.info("tractionrec.prices.fetched", {
      products: productIds.length,
      priced: extras.priceLevelsByProduct.size
    });
  }

  return { records, extras };
}

module.exports = { fetchTier, pluck };
