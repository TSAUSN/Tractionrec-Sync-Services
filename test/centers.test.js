"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { listCenters, getCenter, loadCenter, secretNames, REGISTRY } = require("../src/centers");

const ALPHA = `
alpha:
  name: Alpha
  tractionRec:
    loginUrl: https://alpha.my.salesforce.com/
    apiVersion: v61.0
  zesty:
    instanceZuid: 8-aaaaaaaaaa-abc123
  schedule:
    cron: "0 0 * * *"
    timeZone: America/Chicago
`;

function registry(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "centers-"));
  const file = path.join(dir, "centers.yaml");
  fs.writeFileSync(file, text);
  return file;
}

const SECRETS = {
  "center-alpha-tr-client-id": "id\n",
  "center-alpha-tr-client-secret": "secret",
  "center-alpha-zesty-token": "token"
};
const fromMap =
  (map) =>
  async (name) => {
    if (!(name in map)) {
      throw new Error("NOT_FOUND");
    }
    return map[name];
  };

test("the committed centers.yaml is valid and has phoenix", () => {
  const ids = listCenters(REGISTRY).map((c) => c.id);
  assert.ok(ids.includes("phoenix"));
});

test("centers keep the file's order", () => {
  const file = registry(`${ALPHA}\nbeta:${ALPHA.split("alpha:")[1].replace("name: Alpha", "name: Beta")}`);
  assert.deepEqual(
    listCenters(file).map((c) => c.id),
    ["alpha", "beta"]
  );
});

test("every problem in an entry is named", () => {
  const file = registry(`
Bad_Id:
  name: X
  tractionRec: { loginUrl: http://x, apiVersion: "62" }
  zesty: { instanceZuid: 7-abc }
  schedule: { cron: 0 0, timeZone: Mars/Olympus }
  colour: red
`);
  assert.throws(
    () => listCenters(file),
    (err) =>
      [
        /Bad_Id: the id must be lowercase/,
        /unknown setting colour/,
        /https URL/,
        /apiVersion must look like v62.0/,
        /instance ZUID/,
        /five-field cron/,
        /IANA time zone/
      ].every((re) => re.test(err.message))
  );
});

test("a missing group is named, not a crash", () => {
  const file = registry("alpha:\n  name: Alpha\n");
  assert.throws(() => listCenters(file), /tractionRec is missing[\s\S]*zesty is missing[\s\S]*schedule is missing/);
});

test("an empty registry has no centers", () => {
  assert.deepEqual(listCenters(registry("# nothing yet\n")), []);
});

test("getCenter: unknown and invalid ids are UNKNOWN_CENTER", () => {
  const file = registry(ALPHA);
  assert.equal(getCenter("alpha", file).name, "Alpha");
  for (const id of ["beta", "../alpha", ""]) {
    assert.throws(
      () => getCenter(id, file),
      (err) => err.code === "UNKNOWN_CENTER"
    );
  }
});

test("secretNames follows the naming pattern", () => {
  assert.deepEqual(secretNames("alpha"), [
    "center-alpha-tr-client-id",
    "center-alpha-tr-client-secret",
    "center-alpha-zesty-token"
  ]);
});

test("loadCenter joins the registry entry and the three secrets", async () => {
  const before = process.env.TR_CLIENT_ID;
  process.env.TR_CLIENT_ID = "from-env";
  try {
    const cfg = await loadCenter("alpha", { file: registry(ALPHA), readSecret: fromMap(SECRETS) });
    assert.equal(cfg.center, "alpha");
    assert.equal(cfg.centerName, "Alpha");
    assert.equal(cfg.tr.loginUrl, "https://alpha.my.salesforce.com");
    assert.equal(cfg.tr.apiVersion, "v61.0");
    assert.equal(cfg.tr.clientId, "id", "trimmed, and never from the environment");
    assert.equal(cfg.tr.clientSecret, "secret");
    assert.equal(cfg.zesty.instanceZuid, "8-aaaaaaaaaa-abc123");
    assert.equal(cfg.zesty.token, "token");
  } finally {
    if (before === undefined) {
      delete process.env.TR_CLIENT_ID;
    } else {
      process.env.TR_CLIENT_ID = before;
    }
  }
});

test("apiVersion defaults to v62.0", async () => {
  const file = registry(ALPHA.replace("    apiVersion: v61.0\n", ""));
  const cfg = await loadCenter("alpha", { file, readSecret: fromMap(SECRETS) });
  assert.equal(cfg.tr.apiVersion, "v62.0");
});

test("a missing or empty secret names the secret and how to create it", async () => {
  const file = registry(ALPHA);
  const { "center-alpha-zesty-token": _, ...missing } = SECRETS;
  await assert.rejects(
    loadCenter("alpha", { file, readSecret: fromMap(missing) }),
    /secret center-alpha-zesty-token \(Zesty instance token\)[\s\S]*center-secrets\.sh alpha/
  );
  await assert.rejects(
    loadCenter("alpha", { file, readSecret: fromMap({ ...SECRETS, "center-alpha-tr-client-id": " \n" }) }),
    /center-alpha-tr-client-id.*empty/
  );
});

test("an unknown center is refused before any secret is read", async () => {
  await assert.rejects(
    loadCenter("beta", {
      file: registry(ALPHA),
      readSecret: () => {
        throw new Error("must not be read");
      }
    }),
    (err) => err.code === "UNKNOWN_CENTER"
  );
});

test("HTTP: key first, then a center from centers.yaml", async () => {
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
  const unknown = await call({ center: "nowhere" }, "k");
  assert.equal(unknown.code, 404);
  assert.match(unknown.body.error, /Unknown center "nowhere"/);
  assert.equal((await call({ center: "../etc" }, "k")).code, 404);
  delete process.env.SYNC_TRIGGER_KEY;
});
