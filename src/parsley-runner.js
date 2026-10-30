"use strict";

/**
 * Live Parsley runner for /test-page/. LOCAL DEVELOPMENT ONLY.
 *
 *   npm run runner          # listens on http://127.0.0.1:8787
 *
 * Parsley only executes on Zesty's servers, while a view renders, so a browser
 * cannot run it alone. Running code means writing it into a view, which needs
 * a Zesty write token. That token cannot go in a public page, so it stays in
 * this process, on the developer's machine:
 *
 *   test page (browser)  --POST code-->  this runner (127.0.0.1)
 *        |                                  | 1. code -> DRAFT of /_runner/run.html
 *        |                                  |    (updateView, never published)
 *        |                                  | 2. GET <stage>/test-page/?kroc_run=1
 *        |  <------- rendered output -------|    stage renders drafts, so the
 *                                                draft runs with no publish
 *
 * The test page's view starts with a run-mode branch: when `kroc_run=1` it
 * renders only the included runner view, otherwise the normal page. Going
 * through the page, rather than fetching /_runner/run.html directly, is what
 * gives the code a real `this`: the test page's item, so the Part 2 rows that
 * read `this.integration_test` run as written. Parsley does not evaluate
 * an include inside a false if, so a crashing draft cannot break the normal
 * page (verified 2026-10-01).
 *
 * Safety: binds to 127.0.0.1 only; refuses any Origin but the instance's own
 * domains, so another website cannot drive it; requires a JSON body (which
 * forces a CORS preflight); never publishes. Each run adds one dev version to
 * the scratch view, which is all it leaves behind.
 */

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");

const RUNNER_FILE = "/_runner/run.html";
const PAGE_PATH = "/test-page/";
const RUN_PARAM = "kroc_run";
const MAX_CODE_BYTES = 200 * 1024;
const PLACEHOLDER =
  "<!-- Parsley runner scratch view. Holds DRAFTS only; written and rendered on stage by kroc-tractionrec-sync/src/parsley-runner.js. -->";
const CRASH_TEXT = "There was an error building this page";

// ---- pure helpers (tested) -------------------------------------------------

function markers(nonce) {
  return { start: `<!--kroc-run:${nonce}-->`, end: `<!--/kroc-run:${nonce}-->` };
}

function wrapCode(code, nonce) {
  const m = markers(nonce);
  return `${m.start}${code}${m.end}`;
}

/** The output between this run's markers, or null when the page is not this run's. */
function extractOutput(html, nonce) {
  const m = markers(nonce);
  const a = html.indexOf(m.start);
  const b = html.lastIndexOf(m.end);
  if (a === -1 || b === -1 || b < a) {
    return null;
  }
  return html.slice(a + m.start.length, b);
}

/** fresh | crash | stale — what one stage response means for this run. */
function classify(status, html, nonce) {
  if (extractOutput(html, nonce) !== null) {
    return "fresh";
  }
  if (status >= 500 || html.includes(CRASH_TEXT)) {
    return "crash";
  }
  return "stale";
}

function allowedOrigins(domain, stageHash) {
  const out = new Set([`https://${domain}`]);
  if (stageHash) {
    out.add(`https://${stageHash}-dev.webengine.zesty.io`);
    out.add(`https://${stageHash}-dev.preview.zesty.io`);
  }
  return out;
}

// ---- runner ----------------------------------------------------------------

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function instanceInfo(instanceZuid, token) {
  const res = await fetch(`https://accounts.api.zesty.io/v1/instances/${instanceZuid}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new Error(`instance lookup failed: HTTP ${res.status}`);
  }
  const { data } = await res.json();
  return { domain: data.domain, stageHash: data.randomHashID };
}

/** Find the scratch view, creating it (with a published placeholder) if missing. */
async function ensureRunnerView(zesty) {
  const rows = (await zesty.instance.getViews()).data || [];
  const found = rows.find((v) => v.fileName === RUNNER_FILE);
  if (found) {
    return found.ZUID;
  }
  const res = await zesty.instance.createView({
    code: PLACEHOLDER,
    filename: RUNNER_FILE,
    type: "ajax-html"
  });
  const zuid = res.data.ZUID || res.data.zuid;
  // Published once so the LIVE copy is an inert comment; every run after this
  // writes a draft only.
  await zesty.instance.publishView(zuid, res.data.version || 1);
  return zuid;
}

async function runOnce(ctx, code) {
  const nonce = crypto.randomBytes(6).toString("hex");
  const t0 = Date.now();

  await ctx.zesty.instance.updateView(ctx.viewZuid, {
    code: wrapCode(code, nonce),
    filename: RUNNER_FILE,
    type: "ajax-html"
  });
  const saved = Date.now();

  // Stage normally reflects the draft at once; retry briefly in case it lags,
  // and give a crash one retry so a stale crashed draft is not misreported.
  let crashes = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = `${ctx.stage}${PAGE_PATH}?${RUN_PARAM}=1&cb=${nonce}-${attempt}`;
    const res = await fetch(url);
    const html = await res.text();
    const kind = classify(res.status, html, nonce);
    if (kind === "fresh") {
      return {
        ok: true,
        html: extractOutput(html, nonce),
        ms: { save: saved - t0, render: Date.now() - saved }
      };
    }
    if (kind === "crash" && ++crashes >= 2) {
      return {
        ok: false,
        error:
          "Parsley error: the view failed to build. Zesty gives no detail; common causes are a dotted read into a nested value, printing an object, or an unbalanced tag.",
        status: res.status,
        ms: { save: saved - t0, render: Date.now() - saved }
      };
    }
    await sleep(400);
  }
  return { ok: false, error: "Stage never returned this run's output (timed out)." };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_CODE_BYTES) {
        reject(Object.assign(new Error("code too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function main() {
  loadEnv();
  const SDK = require("@zesty-io/sdk");
  const instanceZuid = process.env.ZESTY_INSTANCE_ZUID;
  const token = process.env.ZESTY_INSTANCE_TOKEN;
  if (!instanceZuid || !token) {
    throw new Error("ZESTY_INSTANCE_ZUID and ZESTY_INSTANCE_TOKEN are required (.env)");
  }
  const port = Number(process.env.RUNNER_PORT || 8787);

  const zesty = new SDK(instanceZuid, token);
  const { domain, stageHash } = await instanceInfo(instanceZuid, token);
  const stage = process.env.ZESTY_STAGE_URL || `https://${stageHash}-dev.webengine.zesty.io`;
  const origins = allowedOrigins(domain, stageHash);
  const viewZuid = await ensureRunnerView(zesty);
  const ctx = { zesty, stage, viewZuid };

  // One run at a time: they share one scratch view.
  let queue = Promise.resolve();

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const send = (status, body) => {
      const headers = { "Content-Type": "application/json", Vary: "Origin" };
      if (origin && origins.has(origin)) {
        headers["Access-Control-Allow-Origin"] = origin;
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };

    if (req.method === "OPTIONS") {
      if (!origins.has(origin)) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        // Chrome's Private/Local Network Access: a public page calling loopback.
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "600",
        Vary: "Origin"
      });
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      send(200, { ok: true, stage, page: PAGE_PATH });
      return;
    }

    if (req.method !== "POST" || req.url !== "/run") {
      send(404, { ok: false, error: "not found" });
      return;
    }
    if (!origins.has(origin)) {
      send(403, { ok: false, error: `origin not allowed: ${origin || "(none)"}` });
      return;
    }
    if (!/^application\/json\b/.test(req.headers["content-type"] || "")) {
      send(415, { ok: false, error: "Content-Type must be application/json" });
      return;
    }

    let code;
    try {
      code = JSON.parse(await readBody(req)).code;
    } catch (err) {
      send(err.status || 400, { ok: false, error: err.message });
      return;
    }
    if (typeof code !== "string" || !code.trim()) {
      send(400, { ok: false, error: "body must be { code: string }" });
      return;
    }

    const job = queue.then(() => runOnce(ctx, code));
    queue = job.catch(() => {});
    try {
      const result = await job;
      console.log(
        `${new Date().toISOString()}  run  ${result.ok ? "ok   " : "ERROR"}  ${code.length} chars` +
          (result.ms ? `  save ${result.ms.save}ms render ${result.ms.render}ms` : "")
      );
      send(200, result);
    } catch (err) {
      console.error("run failed:", err.message);
      send(502, { ok: false, error: err.message });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Parsley runner on http://127.0.0.1:${port}`);
    console.log(`  renders drafts on ${stage}${PAGE_PATH}?${RUN_PARAM}=1`);
    console.log(`  scratch view ${RUNNER_FILE} (${viewZuid}), drafts only`);
    console.log(`  accepts requests from: ${[...origins].join(", ")}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { wrapCode, extractOutput, classify, allowedOrigins, markers, CRASH_TEXT };
