"use strict";

/**
 * The catalog's Zesty page items (models categories, programs, courses,
 * classes): one page per published category, program, course and class,
 * which the tr_* row points at through its `page` relation.
 *
 * Created by this sync (2026-10-29; the archived file sync did it before):
 *   - in the same run as the record's dataset row, before the row is planned,
 *     so the `page` relation is set at once;
 *   - for a PUBLISHED record whose parent already has a page — a program with
 *     no category, or a class whose course has no page, gets none (its row is
 *     inactive anyway);
 *   - with only: tractionrec_id, the title field, and web.pathPart / metaTitle
 *     / metaLinkText. NO parentZUID: every catalog page is at the root
 *     (/class-name/), like the 300+ pages already there (parentZUID null);
 *     a parentZUID nests the URL under the parent's (found 2026-10-29). The
 *     parent's slug is only used to tell two same-named pages apart. Nothing else from Traction Rec is copied
 *     into page fields: the site reads the tr_* rows, and a copy would only go
 *     stale. Editorial fields (hero, icon, intro…) are the editors'. None of
 *     them is required any more (cleared 2026-10-29), so no placeholder values
 *     are needed.
 *
 * Kept in step afterwards — on a RENAME in Traction Rec only:
 *   - the title field, web.metaTitle and web.metaLinkText (the browser tab and
 *     search result title, which the site's code can't override: the <head> is
 *     not editable). An editor's own SEO title survives until the next rename.
 *   - ⚠ NEVER the URL slug (web.pathPart) or anything else sensitive (Japheth
 *     2026-10-29): changing a URL breaks every link to the page. A renamed
 *     class keeps its original URL.
 *
 * Path parts are unique across all four models (they share one root
 * namespace): see paths.js.
 */

const { ok } = require("../zesty/client");
const { uniquePathPart } = require("./paths");
const { byKey } = require("./definitions");
const log = require("../logger");

/** Stand-in ZUID for a page a dry run would have created; never written. */
const DRY_RUN_PAGE_ZUID = "7-000000000000-drypage";

const pathPartOf = (item) =>
  item && item.web ? String(item.web.pathPart || item.web.path || "").replace(/^\/+|\/+$/g, "") : "";

/**
 * The page item of the record's parent, if it has one:
 * programs -> their first category's page, courses -> the program's,
 * classes -> the course's.
 */
function parentPageOf(ds, record, tr, pageItems) {
  if (!ds.page.parent) {
    return null;
  }
  const rel = ds.relations[ds.page.parent];
  const parentDs = byKey(rel.dataset);
  const parentTrId = rel.ids(record, tr).filter(Boolean)[0];
  return (parentTrId && pageItems.get(parentDs.page.model).get(parentTrId)) || null;
}

/**
 * Create the missing pages for a catalog dataset's published records.
 * `pageItems`: model -> Map(trId -> page item), updated in place.
 * Returns [{ trId, name, zuid, pathPart }] and errors.
 */
async function createMissingPages({ zesty, ds, records, tr, models, pageItems, usedPaths, dryRun }) {
  const created = [];
  const errors = [];
  const byTrId = pageItems.get(ds.page.model);
  const modelZuid = models.get(ds.page.model);

  for (const record of records) {
    if (byTrId.has(record.Id)) {
      continue;
    }
    const parent = parentPageOf(ds, record, tr, pageItems);
    if (ds.page.parent && !parent) {
      continue;
    }
    const name = String(ds.name(record) || record.Id).trim();
    const pathPart = uniquePathPart(name, pathPartOf(parent), usedPaths);
    const web = { pathPart, metaTitle: name, metaLinkText: name };
    const data = { tractionrec_id: record.Id, [ds.page.titleField]: name };

    if (dryRun) {
      byTrId.set(record.Id, { meta: { ZUID: DRY_RUN_PAGE_ZUID }, data, web });
      created.push({ trId: record.Id, name, zuid: DRY_RUN_PAGE_ZUID, pathPart });
      continue;
    }
    try {
      const res = ok(await zesty.instance.createItem(modelZuid, { data, web }), `createItem page ${record.Id}`);
      const zuid = res.data && (res.data.ZUID || res.data.zuid);
      ok(await zesty.instance.publishItem(modelZuid, zuid, 1), `publishItem page ${zuid}`);
      byTrId.set(record.Id, { meta: { ZUID: zuid, listed: true }, data, web });
      created.push({ trId: record.Id, name, zuid, pathPart });
      log.info("pages.created", { model: ds.page.model, trId: record.Id, zuid, pathPart });
    } catch (err) {
      errors.push({ stage: "createPage", trId: record.Id, error: err.message });
      log.error("pages.create.failed", { model: ds.page.model, trId: record.Id, error: err.message });
    }
  }
  return { created, errors };
}

/**
 * After a rename in Traction Rec: the page's title field, SEO title and link
 * text follow. The URL slug and every other field are sent back as they are.
 * Returns true when the page was rewritten.
 */
async function renamePage({ zesty, ds, trId, name, models, pageItems, dryRun }) {
  const item = pageItems.get(ds.page.model).get(trId);
  if (!item || !item.meta || item.meta.ZUID === DRY_RUN_PAGE_ZUID) {
    return false;
  }
  const field = ds.page.titleField;
  const web = item.web || {};
  if (item.data[field] === name && web.metaTitle === name && web.metaLinkText === name) {
    return false;
  }
  if (dryRun) {
    return true;
  }
  const modelZuid = models.get(ds.page.model);
  const zuid = item.meta.ZUID;
  const res = ok(
    await zesty.instance.updateItem(modelZuid, zuid, {
      data: { ...item.data, [field]: name },
      meta: { masterZUID: zuid, listed: item.meta.listed !== false },
      // As received — pathPart included — with only the two titles changed.
      web: { ...web, metaTitle: name, metaLinkText: name }
    }),
    `updateItem page ${zuid}`
  );
  const version = res.data && res.data.version;
  if (!version) {
    throw new Error(`updateItem page ${zuid} returned no version, so it cannot be published`);
  }
  ok(await zesty.instance.publishItem(modelZuid, zuid, version), `publishItem page ${zuid} v${version}`);
  item.data = { ...item.data, [field]: name };
  item.web = { ...web, metaTitle: name, metaLinkText: name };
  log.info("pages.renamed", { model: ds.page.model, trId, zuid, name, pathPart: pathPartOf(item) });
  return true;
}

module.exports = { createMissingPages, renamePage, parentPageOf, pathPartOf, DRY_RUN_PAGE_ZUID };
