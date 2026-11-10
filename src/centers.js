"use strict";

/**
 * Kroc centers: one Traction Rec org and one Zesty instance each.
 *
 * centers.yaml (repo root, shipped with the code) is the list: each center's
 * settings, never its passwords. A center exists when it has an entry there.
 * Its three passwords are separate Secret Manager secrets, read by name when
 * a run starts (SECRETS below). Merging a change to centers.yaml deploys it.
 *
 * loadCenter() returns the same shape as config.load(), so a run doesn't care
 * where its settings came from.
 */

const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const REGISTRY = path.join(__dirname, "..", "centers.yaml");
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The three per-center secrets: their name suffix and the config they fill. */
const SECRETS = [
  { suffix: "tr-client-id", label: "Traction Rec client id" },
  { suffix: "tr-client-secret", label: "Traction Rec client secret" },
  { suffix: "zesty-token", label: "Zesty instance token" }
];

const secretNames = (id) => SECRETS.map((s) => `center-${id}-${s.suffix}`);

const bool = (v, dflt) => (v === undefined || v === "" ? dflt : v === "1" || v === "true");

const isCenterId = (id) => ID.test(id || "");

function unknownCenter(id) {
  const err = new Error(`Unknown center "${id}"`);
  err.code = "UNKNOWN_CENTER";
  return err;
}

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const KNOWN = {
  "": ["name", "tractionRec", "zesty", "schedule"],
  tractionRec: ["loginUrl", "apiVersion"],
  zesty: ["instanceZuid"],
  schedule: ["cron", "timeZone"]
};

/** Every problem with one entry, as strings (empty when it's valid). */
function centerProblems(id, c) {
  const problems = [];
  if (!isCenterId(id)) {
    problems.push("the id must be lowercase letters, digits and hyphens");
  }
  if (!c || typeof c !== "object" || Array.isArray(c)) {
    return [...problems, "must be a mapping of settings"];
  }
  for (const [group, keys] of Object.entries(KNOWN)) {
    const obj = group ? c[group] : c;
    if (group && (obj === undefined || typeof obj !== "object" || obj === null)) {
      problems.push(`${group} is missing`);
      continue;
    }
    for (const k of Object.keys(obj)) {
      if (!keys.includes(k)) {
        problems.push(`unknown setting ${group ? `${group}.` : ""}${k}`);
      }
    }
  }
  if (!c.name || typeof c.name !== "string") {
    problems.push("name is missing");
  }
  if (!/^https:\/\/[^\s/]+/.test(c.tractionRec?.loginUrl || "")) {
    problems.push("tractionRec.loginUrl must be an https URL");
  }
  if (c.tractionRec?.apiVersion !== undefined && !/^v\d+\.\d+$/.test(c.tractionRec.apiVersion)) {
    problems.push("tractionRec.apiVersion must look like v62.0");
  }
  if (!/^8-[0-9a-f]+-[0-9a-z]+$/.test(c.zesty?.instanceZuid || "")) {
    problems.push("zesty.instanceZuid must be an instance ZUID (8-…)");
  }
  if (typeof c.schedule?.cron !== "string" || c.schedule.cron.trim().split(/\s+/).length !== 5) {
    problems.push("schedule.cron must be a five-field cron expression, in quotes");
  }
  if (!c.schedule?.timeZone || !validTimeZone(c.schedule.timeZone)) {
    problems.push("schedule.timeZone must be an IANA time zone, e.g. America/Phoenix");
  }
  return problems;
}

/** The registry, checked: [{ id, name, tractionRec, zesty, schedule }], in file order. */
function listCenters(file = REGISTRY) {
  const doc = yaml.load(fs.readFileSync(file, "utf8"), { filename: file }) || {};
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`${path.basename(file)}: must be a mapping of center id -> settings`);
  }
  const problems = Object.entries(doc).flatMap(([id, c]) =>
    centerProblems(id, c).map((p) => `${id}: ${p}`)
  );
  if (problems.length) {
    throw new Error(`${path.basename(file)}:\n  ${problems.join("\n  ")}`);
  }
  return Object.entries(doc).map(([id, c]) => ({ id, ...c }));
}

/** One center by id; UNKNOWN_CENTER if it isn't in the registry. */
function getCenter(id, file = REGISTRY) {
  const center = isCenterId(id) && listCenters(file).find((c) => c.id === id);
  if (!center) {
    throw unknownCenter(id);
  }
  return center;
}

/** One secret's latest value through the Secret Manager client (the function). */
async function readSecretManager(name) {
  const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
  const client = new SecretManagerServiceClient();
  const project = process.env.GCP_PROJECT || (await client.getProjectId());
  const [version] = await client.accessSecretVersion({
    name: `projects/${project}/secrets/${name}/versions/latest`
  });
  return version.payload.data.toString("utf8");
}

/**
 * The run config for one center (same shape as config.load()): its registry
 * entry plus its three secrets. `readSecret(name)` returns a secret's value;
 * the CLI passes one that goes through the gcloud CLI.
 */
async function loadCenter(id, { file = REGISTRY, readSecret = readSecretManager } = {}) {
  const center = getCenter(id, file);
  const names = secretNames(id);
  const values = await Promise.all(
    names.map(async (name, i) => {
      try {
        const v = (await readSecret(name)).trim();
        if (!v) {
          throw new Error("it is empty");
        }
        return v;
      } catch (err) {
        throw new Error(
          `Center "${id}": can't read secret ${name} (${SECRETS[i].label}): ${err.message}. ` +
            `Create it with: bash deploy/center-secrets.sh ${id}`
        );
      }
    })
  );
  const [clientId, clientSecret, token] = values;
  return {
    center: id,
    centerName: center.name,
    dryRun: bool(process.env.DRY_RUN, true),
    triggerKey: process.env.SYNC_TRIGGER_KEY || "",
    tr: {
      loginUrl: center.tractionRec.loginUrl.replace(/\/+$/, ""),
      apiVersion: center.tractionRec.apiVersion || "v62.0",
      clientId,
      clientSecret
    },
    zesty: {
      instanceZuid: center.zesty.instanceZuid,
      token,
      email: "",
      password: ""
    }
  };
}

module.exports = {
  REGISTRY,
  SECRETS,
  secretNames,
  isCenterId,
  centerProblems,
  listCenters,
  getCenter,
  loadCenter
};
