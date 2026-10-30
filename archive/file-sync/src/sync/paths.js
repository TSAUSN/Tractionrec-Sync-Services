"use strict";

const { slugify } = require("./shape");

/**
 * Assign a URL path part that is not already taken.
 *
 * Zesty enforces uniqueness of a path part within its parent scope, and the
 * catalog models are NOT nested — categories, programs, courses and classes
 * all sit at root, so all four compete for a single namespace. Three real
 * collisions on the first live run: the Boxing *category* and the Boxing
 * *program* both want `/boxing/`, likewise `senior-activities`, and two
 * different programs each have a course called "4-6 Age Division".
 *
 * Disambiguation prefers the parent's own path part, because
 * `sports-boxing` and `basketball-4-6-age-division` say something true about
 * where the item sits. A numeric suffix is the fallback when that is still
 * taken or there is no parent.
 *
 * Nesting items under their parent would remove the collision structurally,
 * by giving each parent its own namespace. That is a URL-architecture
 * decision, not a sync one — see docs/sync-flow.md.
 */
function uniquePathPart(title, parentPathPart, used) {
  const base = slugify(title);

  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  // Skip the prefix when it would only repeat the name — the Senior Activities
  // program sits under the Senior Activities category, and
  // `senior-activities-senior-activities` says nothing `senior-activities-2`
  // does not.
  const prefixIsRedundant =
    parentPathPart && (parentPathPart === base || base.startsWith(`${parentPathPart}-`));

  if (parentPathPart && !prefixIsRedundant) {
    const prefixed = slugify(`${parentPathPart}-${base}`);
    if (!used.has(prefixed)) {
      used.add(prefixed);
      return prefixed;
    }
  }

  for (let n = 2; n < 100; n++) {
    const numbered = `${base}-${n}`;
    if (!used.has(numbered)) {
      used.add(numbered);
      return numbered;
    }
  }

  // Nothing readable is free; fall back to something guaranteed unique.
  const unique = `${base}-${Date.now().toString(36)}`;
  used.add(unique);
  return unique;
}

/** Every path part already in use across the models this service writes to. */
function collectUsedPaths(itemsByModel) {
  const used = new Set();
  for (const items of itemsByModel) {
    for (const item of items) {
      const part = item.web && (item.web.pathPart || item.web.path);
      if (part) {
        used.add(String(part).replace(/^\/+|\/+$/g, ""));
      }
    }
  }
  return used;
}

module.exports = { uniquePathPart, collectUsedPaths };
