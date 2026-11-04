"use strict";

/**
 * Dataset item writes. Shapes verified on tr_products:
 *
 *   create   POST, no meta (the SDK strips it); the item is listed by default
 *            and is version 1
 *   update   PUT replaces the version wholesale, so it sends the item's whole
 *            data and meta.listed: true (a PUT without it unlists the item,
 *            which drops it from /-/gql/). The response carries the new version
 *   publish  that version, now. The live domain shows only published items
 */

const { ok } = require("../zesty/client");

/** The web fields a dataset item has, kept as they are apart from the title. */
const KEPT_WEB = ["metaDescription", "metaLinkText", "sitemapPriority", "canonicalTagMode"];

async function publish(zesty, modelZuid, zuid, version) {
  ok(await zesty.instance.publishItem(modelZuid, zuid, version), `publishItem ${zuid} v${version}`);
}

async function createAndPublish(zesty, modelZuid, { name, data }) {
  const res = ok(
    await zesty.instance.createItem(modelZuid, { data, web: { metaTitle: name, metaLinkText: name } }),
    `createItem ${data.tractionrec_id}`
  );
  const zuid = res.data && (res.data.ZUID || res.data.zuid);
  await publish(zesty, modelZuid, zuid, 1);
  return zuid;
}

async function updateAndPublish(zesty, modelZuid, { zuid, name, data, item }) {
  const web = {};
  for (const key of KEPT_WEB) {
    if (item.web && item.web[key] !== undefined) {
      web[key] = item.web[key];
    }
  }
  web.metaTitle = name;
  const res = ok(
    await zesty.instance.updateItem(modelZuid, zuid, {
      // Keep any field the sync does not own (one added in the Manager).
      data: { ...(item.data || {}), ...data },
      meta: { masterZUID: zuid, listed: true },
      web
    }),
    `updateItem ${zuid}`
  );
  const version = res.data && res.data.version;
  if (!version) {
    throw new Error(`updateItem ${zuid} returned no version, so it cannot be published`);
  }
  await publish(zesty, modelZuid, zuid, version);
  return version;
}

module.exports = { createAndPublish, updateAndPublish };
