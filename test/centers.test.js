"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { listLocalCenters, readLocalCenter, readCenter, loadCenter, checkCenter } = require("../src/centers");

const ALPHA = {
  CENTER_NAME: "Alpha",
  TR_LOGIN_URL: "https://alpha.my.salesforce.com/",
  TR_API_VERSION: "v61.0",
  TR_CLIENT_ID: "id",
  TR_CLIENT_SECRET: "secret",
  ZESTY_INSTANCE_ZUID: "8-aaaaaaaaaa-abc123",
  ZESTY_INSTANCE_TOKEN: "token",
  SCHEDULE: "0 0 * * *",
  TIME_ZONE: "America/Chicago"
};

const envText = (env) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

function tmpRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "centers-"));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), body);
  }
  return root;
}

const noSecrets = () => {
  throw new Error("Secret Manager must not be read");
};

test("only .env.<id> files with CENTER_NAME are centers, ordered by id", () => {
  const root = tmpRoot({
    ".env.beta": envText({ ...ALPHA, CENTER_NAME: "Beta" }),
    ".env.alpha": envText(ALPHA),
    ".env": envText(ALPHA),
    ".env.example": "TR_LOGIN_URL=https://x\n",
    ".env.bak": envText({ ...ALPHA, CENTER_NAME: "" }),
    ".env.center.example": envText(ALPHA)
  });
  assert.deepEqual(
    listLocalCenters(root).map((c) => c.id),
    ["alpha", "beta"]
  );
});

test("a center file with problems names each one", () => {
  const root = tmpRoot({
    ".env.alpha": envText({
      CENTER_NAME: "Alpha",
      TR_LOGIN_URL: "http://x",
      ZESTY_INSTANCE_ZUID: "7-x",
      SCHEDULE: "0 0"
    })
  });
  assert.throws(
    () => listLocalCenters(root),
    (err) =>
      /\.env\.alpha/.test(err.message) &&
      /missing TR_CLIENT_ID, TR_CLIENT_SECRET, ZESTY_INSTANCE_TOKEN, TIME_ZONE/.test(err.message) &&
      /https URL/.test(err.message) &&
      /instance ZUID/.test(err.message) &&
      /five-field cron/.test(err.message)
  );
});

test("checkCenter keeps only the center keys", () => {
  const env = checkCenter("alpha", { ...ALPHA, DRY_RUN: "0", OTHER: "x" }, "test");
  assert.equal(env.DRY_RUN, undefined);
  assert.equal(env.OTHER, undefined);
  assert.equal(env.TR_API_VERSION, "v61.0");
});

test("loadCenter reads .env.<id> before Secret Manager", async () => {
  const root = tmpRoot({ ".env.alpha": `# comment\n${envText({ ...ALPHA, TR_CLIENT_ID: '"local-id"' })}\n` });
  const cfg = await loadCenter("alpha", { root, readSecret: noSecrets });
  assert.equal(cfg.center, "alpha");
  assert.equal(cfg.centerName, "Alpha");
  assert.equal(cfg.tr.loginUrl, "https://alpha.my.salesforce.com");
  assert.equal(cfg.tr.apiVersion, "v61.0");
  assert.equal(cfg.tr.clientId, "local-id");
  assert.equal(cfg.zesty.instanceZuid, "8-aaaaaaaaaa-abc123");
  assert.equal(cfg.zesty.token, "token");
});

test("loadCenter falls back to Secret Manager and ignores the process env", async () => {
  const root = tmpRoot({});
  const before = process.env.TR_CLIENT_ID;
  process.env.TR_CLIENT_ID = "from-env";
  try {
    let asked;
    const { TR_API_VERSION, ...secret } = ALPHA;
    const cfg = await loadCenter("alpha", {
      root,
      readSecret: async (id) => {
        asked = id;
        return secret;
      }
    });
    assert.equal(asked, "alpha");
    assert.equal(cfg.tr.clientId, "id");
    assert.equal(cfg.tr.apiVersion, "v62.0");
  } finally {
    if (before === undefined) {
      delete process.env.TR_CLIENT_ID;
    } else {
      process.env.TR_CLIENT_ID = before;
    }
  }
});

test("a secret with a missing key is refused", async () => {
  const root = tmpRoot({});
  await assert.rejects(
    readCenter("alpha", { root, readSecret: async () => ({ CENTER_NAME: "Alpha" }) }),
    /secret center-alpha: missing TR_LOGIN_URL/
  );
});

test("an id that isn't one is unknown before anything is read", async () => {
  await assert.rejects(readCenter("../alpha", { readSecret: noSecrets }), (err) => err.code === "UNKNOWN_CENTER");
  await assert.rejects(readCenter("", { readSecret: noSecrets }), (err) => err.code === "UNKNOWN_CENTER");
});

test("readLocalCenter returns null without a center file", () => {
  const root = tmpRoot({ ".env.alpha": "TR_LOGIN_URL=https://x\n" });
  assert.equal(readLocalCenter("alpha", root), null);
  assert.equal(readLocalCenter("beta", root), null);
});

test("HTTP: key first, then a valid center is required", async () => {
  process.env.SYNC_TRIGGER_KEY = "k";
  require("../src/index");
  const { getFunction } = require("@google-cloud/functions-framework/testing");
  const handler = getFunction("sync");

  const call = async (query, key) => {
    const res = {
      code: 0,
      body: null,
      status(c) {
        this.code = c;
        return this;
      },
      json(b) {
        this.body = b;
        return this;
      }
    };
    await handler({ query, ip: "test", get: (h) => (h === "X-Sync-Key" ? key : undefined) }, res);
    return res;
  };

  assert.equal((await call({ center: "phoenix" }, "wrong")).code, 403);
  assert.equal((await call({}, "k")).code, 400);
  assert.equal((await call({ center: "../etc" }, "k")).code, 404);
  delete process.env.SYNC_TRIGGER_KEY;
});
