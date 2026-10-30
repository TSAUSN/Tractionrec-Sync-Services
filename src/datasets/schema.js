"use strict";

/**
 * The dataset models are created by hand from zesty-models/*.json (the zesty
 * skill's zesty-model.mjs), never by this service. Before a run writes
 * anything it checks that the live models still match those specs, and stops
 * if they don't: a missing field would silently drop a value, and a changed
 * type would fail every write.
 */

const fs = require("node:fs");
const path = require("node:path");
const { ok } = require("../zesty/client");
const { DATASETS, COMMON_FIELDS } = require("./definitions");

const SPEC_DIR = path.join(__dirname, "..", "..", "zesty-models");

/** name -> spec, from the numbered spec files. */
function loadSpecs(dir = SPEC_DIR) {
  const specs = new Map();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const spec = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    specs.set(spec.name, spec);
  }
  return specs;
}

/**
 * Definition <-> spec, no instance needed (also run by the tests): every
 * field a definition fills must be in its spec, and every spec field must be
 * filled by something.
 */
function checkDefinitions(specs) {
  const problems = [];
  for (const ds of DATASETS) {
    const spec = specs.get(ds.key);
    if (!spec) {
      problems.push(`${ds.key}: no spec in zesty-models/`);
      continue;
    }
    const filled = new Set([...COMMON_FIELDS, ...Object.keys(ds.fields), ...Object.keys(ds.relations)]);
    const specced = new Set(spec.fields.map((f) => f.name));
    for (const name of filled) {
      if (!specced.has(name)) {
        problems.push(`${ds.key}.${name}: filled by the sync but not in the spec`);
      }
    }
    for (const name of specced) {
      if (!filled.has(name)) {
        problems.push(`${ds.key}.${name}: in the spec but nothing fills it`);
      }
    }
    for (const [name, rel] of Object.entries(ds.relations)) {
      const f = spec.fields.find((x) => x.name === name);
      const target = rel.dataset || rel.pageModel;
      if (f && f.relatedModel !== target) {
        problems.push(`${ds.key}.${name}: spec relates to ${f.relatedModel}, definition to ${target}`);
      }
    }
  }
  return problems;
}

/**
 * Spec <-> live instance. Returns { problems, fieldsByDataset }, where
 * fieldsByDataset maps a dataset key to Map(fieldName -> datatype) for the
 * value conversions.
 */
async function checkInstance(zesty, models, specs) {
  const problems = [];
  const fieldsByDataset = new Map();

  for (const ds of DATASETS) {
    const spec = specs.get(ds.key);
    const modelZuid = models.get(ds.key);
    if (!spec || !modelZuid) {
      problems.push(`${ds.key}: model not on the instance (create it from zesty-models/)`);
      continue;
    }
    const live = ok(await zesty.instance.getModelFields(modelZuid), `getModelFields ${ds.key}`).data || [];
    const byName = new Map(live.map((f) => [f.name, f]));
    const types = new Map();

    for (const f of spec.fields) {
      const l = byName.get(f.name);
      if (!l) {
        problems.push(`${ds.key}.${f.name}: missing on the instance`);
        continue;
      }
      if (l.datatype !== f.datatype) {
        problems.push(`${ds.key}.${f.name}: instance has ${l.datatype}, spec says ${f.datatype}`);
        continue;
      }
      if (f.relatedModel && l.relatedModelZUID !== models.get(f.relatedModel)) {
        problems.push(`${ds.key}.${f.name}: relates to ${l.relatedModelZUID}, spec says ${f.relatedModel}`);
        continue;
      }
      types.set(f.name, f.datatype);
    }
    fieldsByDataset.set(ds.key, types);
  }
  return { problems, fieldsByDataset };
}

module.exports = { loadSpecs, checkDefinitions, checkInstance, SPEC_DIR };
