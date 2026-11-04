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
 * Publish the record exactly as Salesforce returned it.
 *
 * No renaming, no flattening, no derived keys. Traction Rec's field names ARE
 * the published names, so there is no mapping to maintain and no chance of it
 * drifting — a class of bug this project already hit once, with an invented
 * `Available_Capacity__c` that does not exist.
 *
 * The only thing removed is Salesforce's `attributes` envelope (its `type` and
 * `url`), which describes the API response rather than the record. Nested
 * `__r` objects are kept as-is: that nesting is Traction Rec's own structure,
 * and JavaScript handles it natively. Parsley cannot read below the root, so
 * on Class — the one tier with `__r` objects — those fields are JS-only.
 */
function rawRecord(value) {
  if (Array.isArray(value)) {
    return value.map(rawRecord);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "attributes") {
        continue;
      }
      out[k] = rawRecord(v);
    }
    return out;
  }
  return value;
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
  const productId = pluck(record, tier.priceJoin.productPath);
  const levels = extras.priceLevelsByProduct?.get(productId) || [];
  return levels.map((lvl) => {
    const price = {
      id: lvl.Id,
      name: lvl.Name,
      // "Member" | "Non-Member" | null
      priceType: lvl.TREX1__Price_Type__c ?? null,
      amount: lvl[tier.priceJoin.amountField] ?? null,
      initialFee: lvl.TREX1__Initial_Fee_Amount__c ?? null
    };
    // Membership tiers only, so a class row (and its hash) is unchanged.
    if (tier.priceJoin.schedules) {
      price.schedules = (extras.schedulesByLevel?.get(lvl.Id) || [])
        .map((s) => ({
          id: s.Id,
          name: s.Name,
          // "Monthly" (Autopay) | "One Time"
          termType: s.TREX1__Term_Type__c ?? null,
          amount: s.TREX1__Amount__c ?? null,
          totalAmount: s.TREX1__Total_Billing_Amount__c ?? null,
          numberOfTerms: s.TREX1__Number_Of_Terms__c ?? null
        }))
        .sort((a, b) => String(a.id).localeCompare(b.id));
    }
    return price;
  });
}

/**
 * Build the object that becomes one snapshot file.
 *
 * Salesforce's fields sit at the ROOT of the file, with the sync's own
 * bookkeeping tucked under `meta`:
 *
 *     { Id, Name, TREX1__Program__c, …, meta: { hash, syncedAt, … } }
 *
 * The root is not cosmetic. Parsley's `api.json.get()` binds each row as a
 * one-level key -> scalar map: a top-level scalar renders, but any dotted read
 * (`r.data.Name`) or print of a nested object crashes the whole page. The
 * earlier `{ meta, data }` envelope put every field one level down, so Parsley
 * could loop the file and read nothing out of it. Nested values are harmless
 * as long as nothing reads them, which is why `meta` can stay nested.
 * Verified on fixtures — see docs/relationships-without-zesty-fields.md.
 *
 * `meta.hash` covers everything except `meta`. It deliberately excludes
 * `syncedAt`, so a run that finds nothing changed writes nothing — which is
 * what keeps a 15-minute cron from generating a version history nobody wants.
 */
function buildSnapshot({ tierKey, tier, record, extras, now = new Date() }) {
  const fields = rawRecord(record);
  const parents = parentIdsFor(tier, record, extras);
  const prices = pricesFor(tier, record, extras);

  // Keys the sync adds beside Salesforce's. `relationKey` is set on exactly
  // one tier — Program, whose category link lives in a junction rather than on
  // the record — and is named after that junction's own lookup field. Course
  // and Class need nothing added: their parent is already on the record.
  const added = {};
  if (tier.relationKey) {
    added[tier.relationKey] = parents;
  }
  if (prices) {
    added.prices = prices;
  }

  // Sharing the root with Salesforce means a clash would silently overwrite
  // real data. Salesforce API names are PascalCase or end in `__c`/`__r`, so
  // `meta`/`prices` cannot occur — but a relationKey could, if the field list
  // ever starts querying the same name.
  for (const key of [...Object.keys(added), "meta"]) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      throw new Error(`${tier.trObject}.${key} collides with a key the sync adds`);
    }
  }

  const payload = { ...fields, ...added };

  return {
    ...payload,
    meta: {
      tier: tierKey,
      tractionrecObject: tier.trObject,
      tractionrecId: record.Id,
      sourceModstamp: record.SystemModstamp || null,
      syncedAt: now.toISOString(),
      hash: hash(payload)
    }
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

/**
 * Zesty's half of a record file's `meta`: which item owns the record and the
 * URL that item answers on. Pages link cards with `zestyPath`, so a URL changed
 * in the Manager has to reach the files on the next run, not only when the
 * Traction Rec record next changes.
 *
 * Root-level items answer on `/<pathPart>/`: the catalog models are not
 * nested, verified (`/senior-activities-2/`, `/hip-hop-step-lvl-2/`).
 */
function linkItem(snapshot, { zuid, path }) {
  snapshot.meta.zestyItemZuid = zuid || null;
  snapshot.meta.zestyPath = path || null;
  return snapshot;
}

/**
 * What the ledger stores for a record file: the record's own hash plus the
 * Zesty item and URL it points at. A change to any of the three rewrites the
 * file; `syncedAt` never does.
 */
function fileKey(snapshot) {
  const m = snapshot.meta || {};
  return hash([m.hash, m.zestyItemZuid || null, m.zestyPath || null]);
}

module.exports = { buildSnapshot, titleFor, slugify, hash, canonical, rawRecord, linkItem, fileKey };
