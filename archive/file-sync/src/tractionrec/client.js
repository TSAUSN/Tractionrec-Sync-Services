"use strict";

const { mintToken } = require("./auth");
const log = require("../logger");

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Thin SOQL client.
 *
 * Two behaviours matter and both come from how this org is configured:
 *
 *  1. The session has no refresh token, so any 401 / INVALID_SESSION_ID is met
 *     with a fresh client_credentials mint and ONE retry.
 *  2. /query pages via `nextRecordsUrl` at 2,000 records a page. The whole
 *     catalog is ~5,100 records, so Bulk API is unnecessary; this pages.
 */
class TractionRecClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.token = null;
    this.instanceUrl = cfg.loginUrl;
  }

  async auth(force = false) {
    if (this.token && !force) {
      return this.token;
    }
    const { accessToken, instanceUrl } = await mintToken(this.cfg);
    this.token = accessToken;
    this.instanceUrl = instanceUrl || this.cfg.loginUrl;
    return this.token;
  }

  async request(path, { attempt = 0, reauthed = false } = {}) {
    await this.auth();

    const url = path.startsWith("http") ? path : `${this.instanceUrl}${path}`;
    const res = await fetch(url, {
      headers: {
        // Verified: `?access_token=` in the query string returns 401 on this
        // org. The header is mandatory.
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json"
      }
    });

    if (res.status === 401 && !reauthed) {
      log.warn("tractionrec.session.expired", { path });
      await this.auth(true);
      return this.request(path, { attempt, reauthed: true });
    }

    if (RETRYABLE_STATUS.has(res.status) && attempt < 4) {
      const wait = Math.min(2 ** attempt * 500, 8000);
      log.warn("tractionrec.retry", { status: res.status, attempt, waitMs: wait });
      await sleep(wait);
      return this.request(path, { attempt: attempt + 1, reauthed });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`TractionRec ${res.status} on ${path}: ${text.slice(0, 500)}`);
    }

    return res.json();
  }

  /** Run a SOQL statement, following pagination to completion. */
  async query(soql) {
    const first = `/services/data/${this.cfg.apiVersion}/query?q=${encodeURIComponent(soql)}`;
    let page = await this.request(first);
    const records = [...page.records];

    while (!page.done && page.nextRecordsUrl) {
      page = await this.request(page.nextRecordsUrl);
      records.push(...page.records);
    }

    log.debug("tractionrec.query", { total: records.length, soql });
    return records;
  }
}

module.exports = { TractionRecClient };
