"use strict";

/**
 * Traction Rec value -> the value a Zesty field of a given datatype stores.
 *
 * Every rule here comes from the probes
 * (docs/dataset-storage.md §1), where the instance API was tried with each
 * shape Salesforce returns:
 *
 *   text        at most 150 characters; 151 is a 400 "Data too long"
 *   textarea    at most 65,535
 *   number      null stays null; "" or text is a 500, so empty is null
 *   currency    stored as a string
 *   yes_no      an omitted value becomes 0, so it is always sent, 0 or 1
 *   date        "YYYY-MM-DD"; an invalid date is a 500
 *   datetime    "YYYY-MM-DD HH:MM:SS", UTC (Salesforce returns UTC)
 *   one_to_one  one ZUID; one_to_many a comma-joined list. Zesty validates
 *               neither, so the caller resolves them (plan.js)
 *
 * A value that cannot be stored is not sent as-is: it becomes null (or is
 * truncated) and a warning names the field, so one odd record never fails the
 * write of everything else on it.
 */

const LIMITS = { text: 150, textarea: 65535, wysiwyg_basic: 65535, link: 65535 };

const isEmpty = (v) => v === null || v === undefined || v === "";

/** Truncate by characters (code points), which is how Zesty counts. */
function clip(text, max, warn) {
  const chars = [...text];
  if (chars.length <= max) {
    return text;
  }
  warn(`truncated from ${chars.length} to ${max} characters`);
  return chars.slice(0, max).join("");
}

/** "2025-02-20T22:12:35.000+0000" -> "2025-02-20 22:12:35" (UTC). */
function toZestyDatetime(value) {
  // Salesforce's offset has no colon; Date.parse wants "+00:00".
  const iso = String(value).replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Convert one value. Returns { value, warning } where warning is null or a
 * short sentence for the run report.
 */
function convert(datatype, raw) {
  let warning = null;
  const warn = (msg) => {
    warning = msg;
  };

  switch (datatype) {
    case "text":
    case "textarea":
    case "wysiwyg_basic":
    case "link": {
      if (isEmpty(raw)) {
        return { value: null, warning };
      }
      return { value: clip(String(raw), LIMITS[datatype], warn), warning };
    }
    case "number": {
      if (isEmpty(raw)) {
        return { value: null, warning };
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        return { value: null, warning: `not a number: ${JSON.stringify(raw)}` };
      }
      return { value: n, warning };
    }
    case "currency": {
      if (isEmpty(raw)) {
        return { value: null, warning };
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        return { value: null, warning: `not an amount: ${JSON.stringify(raw)}` };
      }
      return { value: String(n), warning };
    }
    case "yes_no":
      return { value: raw === true || raw === 1 || raw === "1" || raw === "true" ? 1 : 0, warning };
    case "date": {
      if (isEmpty(raw)) {
        return { value: null, warning };
      }
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(raw));
      if (!m || !Number.isFinite(Date.parse(m[1]))) {
        return { value: null, warning: `not a date: ${JSON.stringify(raw)}` };
      }
      return { value: m[1], warning };
    }
    case "datetime": {
      if (isEmpty(raw)) {
        return { value: null, warning };
      }
      const value = toZestyDatetime(raw);
      return { value, warning: value ? null : `not a datetime: ${JSON.stringify(raw)}` };
    }
    case "one_to_one":
      return { value: isEmpty(raw) ? null : String(raw), warning };
    case "one_to_many": {
      const list = (Array.isArray(raw) ? raw : [raw]).filter((z) => !isEmpty(z));
      return { value: list.length ? list.join(",") : null, warning };
    }
    default:
      throw new Error(`No conversion for Zesty datatype "${datatype}"`);
  }
}

module.exports = { convert, toZestyDatetime, LIMITS };
