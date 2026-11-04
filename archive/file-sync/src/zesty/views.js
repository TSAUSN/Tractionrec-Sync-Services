"use strict";

const { ok } = require("./client");
const { SNAPSHOT_ROOT } = require("../config");
const log = require("../logger");

/**
 * A Zesty view is Parsley-processed, INCLUDING inside strings and comments.
 * A literal double-open-curly anywhere in a snapshot would be evaluated as
 * markup — which at best mangles the file and at worst throws a WebEngine
 * error on every request for it.
 *
 * Traction Rec rich-text carries hand-pasted HTML, so this is not theoretical.
 * The fix works because a JSON parser resolves { back to "{", while
 * Parsley only ever sees the six-character escape sequence.
 */
function parsleySafeJson(value) {
  return (
    JSON.stringify(value, null, 2)
      .replace(/\{\{/g, "\\u007b\\u007b")
      // Pages inline these files in a <script type="application/json"> with
      // {{ include }}. A literal "</script" inside a string would end that
      // element early; "<\/" is the same JSON string and can't close anything.
      .replace(/<\//g, "<\\/")
  );
}

/**
 * Normalise to exactly one leading slash — the form the WebEngine router
 * serves. See SNAPSHOT_ROOT in config.js for what happens without it.
 */
function viewPath(filename) {
  return "/" + String(filename).replace(/^\/+/, "");
}

/** /tractionrec/<tier>/<tractionRecId>.json */
function snapshotPath(tierKey, tractionRecId) {
  return viewPath(`${SNAPSHOT_ROOT}/${tierKey}/${tractionRecId}.json`);
}

/**
 * One listing per run, indexed by filename. The alternative — probing each
 * path before writing — is ~1,000 extra requests for no extra information.
 *
 * Verified: `/web/views` returns ONE ROW PER STATUS, so every view
 * appears twice, once `dev` and once `live`, and their `version` values differ
 * whenever a view has unpublished edits. Taking whichever row arrives last
 * would hand `publishView` a stale version number. Keep the highest.
 */
/** The pure half: fold raw listing rows into one entry per filename. */
function indexViewRows(rows) {
  const byFilename = new Map();

  for (const view of rows || []) {
    const filename = view.fileName || view.filename || view.path;
    if (!filename) {
      continue;
    }

    const key = viewPath(filename);
    const version = Number(view.version) || 0;
    const previous = byFilename.get(key);

    if (previous && previous.version >= version) {
      previous.statuses.add(view.status);
      continue;
    }

    byFilename.set(key, {
      zuid: view.ZUID || view.zuid,
      version,
      type: view.type,
      statuses: new Set([...(previous ? previous.statuses : []), view.status])
    });
  }

  return byFilename;
}

async function indexViews(zesty) {
  const res = ok(await zesty.instance.getViews(), "getViews");
  const byFilename = indexViewRows(res.data);

  log.info("zesty.views.indexed", {
    rows: (res.data || []).length,
    views: byFilename.size,
    snapshots: [...byFilename.keys()].filter((f) => f.startsWith(`${SNAPSHOT_ROOT}/`)).length
  });

  return byFilename;
}

/**
 * Create or update a snapshot view, then publish it.
 *
 * Publishing is not optional: an unpublished view exists in the Manager but
 * does not answer on the live domain, so the front end would 404 on exactly
 * the files this service exists to produce.
 */
async function writeSnapshot(zesty, viewIndex, { filename, payload, dryRun }) {
  const code = parsleySafeJson(payload);
  const existing = viewIndex.get(filename);

  if (dryRun) {
    return { action: existing ? "would-update" : "would-create", filename, bytes: code.length };
  }

  if (existing) {
    const res = ok(
      await zesty.instance.updateView(existing.zuid, {
        code,
        filename,
        type: "ajax-json"
      }),
      `updateView ${filename}`
    );
    // updateView does not reliably return the version it created, and falling
    // back to `existing.version` re-publishes the OLD code — which is exactly
    // what used to happen: every refresh wrote a new dev version
    // and left the live file stale. Read the version back instead.
    let version = res.data && res.data.version;
    if (!version || version <= existing.version) {
      const current = ok(await zesty.instance.getView(existing.zuid), `getView ${filename}`);
      version = current.data.version;
    }
    ok(await zesty.instance.publishView(existing.zuid, version), `publishView ${filename}`);
    return { action: "updated", filename, zuid: existing.zuid, version };
  }

  const res = ok(
    await zesty.instance.createView({ code, filename, type: "ajax-json" }),
    `createView ${filename}`
  );
  const zuid = res.data && (res.data.ZUID || res.data.zuid);
  const version = (res.data && res.data.version) || 1;
  ok(await zesty.instance.publishView(zuid, version), `publishView ${filename}`);

  viewIndex.set(filename, { zuid, version, type: "ajax-json", statuses: new Set(["dev"]) });
  return { action: "created", filename, zuid, version };
}

module.exports = { parsleySafeJson, viewPath, snapshotPath, indexViewRows, indexViews, writeSnapshot };
