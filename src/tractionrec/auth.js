"use strict";

const log = require("../logger");

/**
 * OAuth 2.0 client_credentials against the Traction Rec Salesforce org.
 *
 * Verified shape of the response: `access_token`, `instance_url`, `token_type`,
 * and NOTHING ELSE — no `refresh_token`, no `expires_in`. The session simply
 * dies (~2h by org policy) and the only recovery is to mint a new one, which
 * is why callers re-auth on INVALID_SESSION_ID rather than on a timer.
 */
async function mintToken({ loginUrl, clientId, clientSecret }) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret
  });

  const res = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok || !json.access_token) {
    // Never log the body: an error response can echo back request parameters.
    throw new Error(
      `TractionRec auth failed (${res.status} ${json.error || "unknown"}). ` +
        "Check TR_CLIENT_ID / TR_CLIENT_SECRET and that the connected app still " +
        "permits client_credentials for the integration user."
    );
  }

  log.info("tractionrec.auth.ok", { instanceUrl: json.instance_url });

  return { accessToken: json.access_token, instanceUrl: json.instance_url };
}

module.exports = { mintToken };
