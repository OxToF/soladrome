// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
//
// The resolve hook behind `json-loader.mjs`. It teaches Node the two things webpack already
// knows about this app's source, so that `plan-probe.mts` can import the app's own modules
// rather than a copy of them:
//
//   · a `.json` specifier carries the import attribute Node insists on;
//   · a relative import with no extension means the `.ts` file next to it;
//   · `@/x` is the app root, as `tsconfig.json` `paths` declares it.
//
// Both are conventions of the app's build, not of Node. Changing the app to suit a terminal
// script would be the tail wagging the dog.
const APP_ROOT = new URL("../", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    specifier = new URL(specifier.slice(2), APP_ROOT).href;
  }
  try {
    const resolved = await nextResolve(specifier, context);
    if (resolved.url.endsWith(".json")) {
      return { ...resolved, importAttributes: { ...resolved.importAttributes, type: "json" } };
    }
    return resolved;
  } catch (err) {
    // Relative, or already rewritten from `@/` into a file URL — either way it is this app's
    // source, where an extensionless import means the `.ts` file. A bare package name is not.
    if (err?.code === "ERR_MODULE_NOT_FOUND" && /^(\.{1,2}\/|file:)/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw err;
  }
}
