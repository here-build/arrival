// docs-freshness.test.ts — string-absence verdict over the package docs.
//
// Guards against two stale claims that were true on disk before node H2:
//   1. the dependency was renamed `@here.build/arrival-scheme` → `@inhuman.tools/arrival`.
//   2. arrival's exports map no longer "publishes only" `.`/`./test-env`; the `./oracle`
//      subpath is published, so any "publishes only ..." phrasing is now false.
// Red before the H2 doc fixes; green after.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, "..", "..");

const docs = {
  "README.md": readFileSync(path.join(pkgRoot, "README.md"), "utf8"),
  "src/oracle-types.ts": readFileSync(path.join(pkgRoot, "src", "oracle-types.ts"), "utf8"),
};

describe("docs freshness", () => {
  it.each(Object.entries(docs))("%s no longer names the dependency @here.build/arrival-scheme", (_name, text) => {
    expect(text).not.toContain("@here.build/arrival-scheme");
  });

  it.each(Object.entries(docs))('%s no longer makes the stale "publishes only" exports claim', (_name, text) => {
    expect(text).not.toContain("publishes only");
  });
});
