"use strict";

const crypto = require("node:crypto");

/**
 * Canonical JSON: keys sorted at every level, so the hash of a record depends
 * on its values and not on the order Salesforce happened to serialise them.
 */
function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function hash(value) {
  return "sha256:" + crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

module.exports = { canonical, hash };
