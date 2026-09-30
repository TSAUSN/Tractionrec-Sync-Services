"use strict";

const crypto = require("node:crypto");
const { pluck } = require("../tractionrec/fetch-tier");

/**
 * Canonical JSON: keys sorted at every level, so the hash of a record depends
 * on its values and not on the order Salesforce happened to serialise them.
 */
function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function hash(value) {
  return "sha256:" + crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

/**
 * A tier's `trFields` entry is either a SOQL path or a `[path, outputKey]`
 * pair. The pair form exists because derived names for nested lookups read
 * badly — `csoCourseSessionSessionName` for a field everyone calls "season".
 */
function fieldPath(field) {
  return Array.isArray(field) ? field[0] : field;
}

/** Derive a camelCase key from a SOQL path when the tier did not name one. */
function deriveKey(path) {
  const words = [];
  for (const segment of path.split(".")) {
    const bare = segment.replace(/^TREX1__/, "").replace(/__[cr]$/, "");
    words.push(...bare.split("_").filter(Boolean));
  }
  return words
    .map((w, i) =>
      i === 0
        ? w.charAt(0).toLowerCase() + w.slice(1)
        : w.charAt(0).toUpperCase() + w.slice(1)
    )
    .join("");
}

function fieldKey(field) {
  return Array.isArray(field) ? field[1] : deriveKey(field);
}

/** Strip the managed-package noise so consumers read `available`, not `TREX1__Available__c`. */
function flatten(record, fields) {
  const out = {};
  for (const field of fields) {
    out[fieldKey(field)] = pluck(record, fieldPath(field)) ?? null;
  }
  return out;
}

function parentIdsFor(tier, record, extras) {
  if (!tier.parentVia) {
    return [];
  }
  if (tier.parentVia.junction) {
    return extras.parentByChild?.get(record.Id) || [];
  }
  const id = pluck(record, tier.parentVia.lookup);
  return id ? [id] : [];
}

/**
 * Price is attached rather than flattened, because a Product carries several
 * Price Levels (member / non-member / resident) and which one applies is a
 * question the site cannot answer — one fixed integration identity means the
 * service never knows who is viewing. Render every level and let the
 * registration deep link resolve entitlement after the hand-off.
 */
function pricesFor(tier, record, extras) {
  if (!tier.priceJoin) {
    return undefined;
  }
  const productId = pluck(record, "TREX1__Course_Option__r.TREX1__Product__c");
  const levels = extras.priceLevelsByProduct?.get(productId) || [];
  return levels.map((lvl) => ({
    id: lvl.Id,
    name: lvl.Name,
    // "Member" | "Non-Member" | null
    priceType: lvl.TREX1__Price_Type__c ?? null,
    amount: lvl[tier.priceJoin.amountField] ?? null,
    initialFee: lvl.TREX1__Initial_Fee_Amount__c ?? null
  }));
}

/**
 * Build the object that becomes one snapshot file.
 *
 * `meta.hash` covers `data` and `parents` only. It deliberately excludes
 * `syncedAt`, so a run that finds nothing changed writes nothing — which is
 * what keeps a 15-minute cron from generating a version history nobody wants.
 */
function buildSnapshot({ tierKey, tier, record, extras, now = new Date() }) {
  const data = flatten(record, tier.trFields);
  const parents = parentIdsFor(tier, record, extras);
  const prices = pricesFor(tier, record, extras);

  const payload = { data, parents };
  if (prices) {
    payload.prices = prices;
  }

  return {
    meta: {
      tier: tierKey,
      tractionrecObject: tier.trObject,
      tractionrecId: record.Id,
      parents,
      sourceModstamp: record.SystemModstamp || null,
      syncedAt: now.toISOString(),
      hash: hash(payload)
    },
    ...payload
  };
}

/** The display name for a record, used for the item title and the path part. */
function titleFor(tier, record) {
  return String(pluck(record, tier.trNameField) || record.Id).trim();
}

function slugify(text) {
  return (
    String(text)
      .trim()
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "item"
  );
}

module.exports = { buildSnapshot, titleFor, slugify, hash, canonical, flatten, fieldPath, fieldKey };
