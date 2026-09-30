"use strict";

const SDK = require("@zesty-io/sdk");
const log = require("../logger");

/**
 * Build an authenticated SDK client.
 *
 * Prefer ZESTY_INSTANCE_TOKEN. The email/password path exists because the SDK
 * offers it, but it ties the service to a human account: if that person leaves
 * or rotates their password the cron dies silently at 3am.
 */
async function connect(cfg) {
  let token = cfg.token;

  if (!token) {
    if (!cfg.email || !cfg.password) {
      throw new Error(
        "Zesty auth requires ZESTY_INSTANCE_TOKEN, or ZESTY_USER_EMAIL + ZESTY_USER_PASSWORD."
      );
    }
    const auth = new SDK.Auth();
    const res = await auth.login(cfg.email, cfg.password);
    if (!res.token) {
      throw new Error(`Zesty login failed (${res.statusCode}): ${res.message || "no token"}`);
    }
    token = res.token;
    log.warn("zesty.auth.password", {
      message: "Authenticated with a user password. Use an instance token in production."
    });
  }

  return new SDK(cfg.instanceZuid, token);
}

/**
 * The SDK resolves rather than rejects on API errors — it returns the parsed
 * body with a `statusCode`. Anything that is not 2xx has to be turned into a
 * throw by the caller or a failed write looks exactly like a successful one.
 */
function ok(res, what) {
  const code = res && res.statusCode;
  if (typeof code === "number" && code >= 200 && code < 300) {
    return res;
  }
  throw new Error(
    `Zesty ${what} failed (${code}): ${res && (res.message || JSON.stringify(res).slice(0, 300))}`
  );
}

module.exports = { connect, ok };
