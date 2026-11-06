"use strict";

/**
 * Kroc centers: one Traction Rec org and one Zesty instance each.
 *
 * Everything about a center is one set of KEY=value settings (CENTER_KEYS):
 *   - locally, the file .env.<id> in the repo root (gitignored). A file
 *     counts as a center only when it sets CENTER_NAME, so .env.example and
 *     backups are ignored;
 *   - deployed, the Secret Manager secret "center-<id>" (the same settings as
 *     JSON), read when a run starts. A center exists when its secret does, so
 *     adding one needs no redeploy.
 *
 * loadCenter() returns the same shape as config.load(), so a run doesn't care
 * where its settings came from.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const CENTER_KEYS = {
  required: [
    "CENTER_NAME",
    "TR_LOGIN_URL",
    "TR_CLIENT_ID",
    "TR_CLIENT_SECRET",
    "ZESTY_INSTANCE_ZUID",
    "ZESTY_INSTANCE_TOKEN",
    "SCHEDULE",
    "TIME_ZONE"
  ],
  optional: ["TR_API_VERSION"]
};
const ALL_KEYS = [...CENTER_KEYS.required, ...CENTER_KEYS.optional];

const bool = (v, dflt) => (v === undefined || v === "" ? dflt : v === "1" || v === "true");

const secretName = (id) => `center-${id}`;
const isCenterId = (id) => ID.test(id || "");

function unknownCenter(id) {
  const err = new Error(`Unknown center "${id}"`);
  err.code = "UNKNOWN_CENTER";
  return err;
}

/** KEY=value lines, quotes stripped; comments and blank lines ignored. */
function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) {
      out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

/** Only the center keys, checked; throws naming every problem. */
function checkCenter(id, env, where) {
  const problems = [];
  if (!isCenterId(id)) {
    problems.push(`id "${id}" must be lowercase letters, digits and hyphens`);
  }
  const missing = CENTER_KEYS.required.filter((k) => !env[k]);
  if (missing.length) {
    problems.push(`missing ${missing.join(", ")}`);
  }
  if (env.TR_LOGIN_URL && !/^https:\/\//.test(env.TR_LOGIN_URL)) {
    problems.push("TR_LOGIN_URL must be an https URL");
  }
  if (env.ZESTY_INSTANCE_ZUID && !/^8-[0-9a-f]+-[0-9a-z]+$/.test(env.ZESTY_INSTANCE_ZUID)) {
    problems.push("ZESTY_INSTANCE_ZUID must be an instance ZUID (8-…)");
  }
  if (env.SCHEDULE && env.SCHEDULE.trim().split(/\s+/).length !== 5) {
    problems.push("SCHEDULE must be a five-field cron expression");
  }
  if (problems.length) {
    throw new Error(`${where}: ${problems.join("; ")}`);
  }
  return Object.fromEntries(ALL_KEYS.filter((k) => env[k]).map((k) => [k, env[k]]));
}

/** The centers defined on this machine: [{ id, env }], ordered by id. */
function listLocalCenters(root = ROOT) {
  return fs
    .readdirSync(root)
    .map((f) => f.match(/^\.env\.(.+)$/))
    .filter((m) => m && isCenterId(m[1]))
    .map((m) => ({ id: m[1], env: parseEnv(fs.readFileSync(path.join(root, m[0]), "utf8")) }))
    .filter((c) => c.env.CENTER_NAME)
    .map((c) => ({ id: c.id, env: checkCenter(c.id, c.env, `.env.${c.id}`) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** A center's settings from .env.<id>, or null when it isn't a center file here. */
function readLocalCenter(id, root = ROOT) {
  const file = path.join(root, `.env.${id}`);
  if (!isCenterId(id) || !fs.existsSync(file)) {
    return null;
  }
  const env = parseEnv(fs.readFileSync(file, "utf8"));
  return env.CENTER_NAME ? checkCenter(id, env, `.env.${id}`) : null;
}

/** A center's settings from Secret Manager ("center-<id>", latest version). */
async function readSecretManager(id) {
  const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
  const client = new SecretManagerServiceClient();
  const project = process.env.GCP_PROJECT || (await client.getProjectId());
  try {
    const [version] = await client.accessSecretVersion({
      name: `projects/${project}/secrets/${secretName(id)}/versions/latest`
    });
    return JSON.parse(version.payload.data.toString("utf8"));
  } catch (err) {
    // NOT_FOUND, or PERMISSION_DENIED: the runtime account is granted each
    // center secret one by one, so a secret that doesn't exist reads as denied.
    if (err.code === 5 || err.code === 7) {
      throw unknownCenter(id);
    }
    throw err;
  }
}

/** A center's checked settings: .env.<id> when it's here, else Secret Manager. */
async function readCenter(id, { root = ROOT, readSecret = readSecretManager } = {}) {
  if (!isCenterId(id)) {
    throw unknownCenter(id);
  }
  const local = readLocalCenter(id, root);
  if (local) {
    return local;
  }
  return checkCenter(id, await readSecret(id), `secret ${secretName(id)}`);
}

/** The run config for one center (same shape as config.load()). */
async function loadCenter(id, opts) {
  const env = await readCenter(id, opts);
  return {
    center: id,
    centerName: env.CENTER_NAME,
    dryRun: bool(process.env.DRY_RUN, true),
    triggerKey: process.env.SYNC_TRIGGER_KEY || "",
    tr: {
      loginUrl: env.TR_LOGIN_URL.replace(/\/+$/, ""),
      apiVersion: env.TR_API_VERSION || "v62.0",
      clientId: env.TR_CLIENT_ID,
      clientSecret: env.TR_CLIENT_SECRET
    },
    zesty: {
      instanceZuid: env.ZESTY_INSTANCE_ZUID,
      token: env.ZESTY_INSTANCE_TOKEN,
      email: "",
      password: ""
    }
  };
}

module.exports = {
  CENTER_KEYS,
  secretName,
  isCenterId,
  parseEnv,
  checkCenter,
  listLocalCenters,
  readLocalCenter,
  readCenter,
  loadCenter
};
