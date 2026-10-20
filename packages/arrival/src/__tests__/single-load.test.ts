import { describe, expect, it } from "vitest";
import { assertSingleLoad, DuplicateModuleLoadError } from "../single-load.js";

describe("assertSingleLoad", () => {
  it("throws DuplicateModuleLoadError on a second evaluation of the same module id", () => {
    // eslint-disable-next-line sonarjs/pseudo-random -- unique-name nonce for test isolation, not security-sensitive
    const id = `test/single-load/${Date.now()}-${Math.random()}`;
    assertSingleLoad(id);
    expect(() => assertSingleLoad(id)).toThrow(DuplicateModuleLoadError);
    expect(() => assertSingleLoad(id)).toThrow(/evaluated twice in this isolate/);
  });

  it("does not confuse two distinct module ids", () => {
    // eslint-disable-next-line sonarjs/pseudo-random -- unique-name nonce for test isolation, not security-sensitive
    const a = `test/single-load/a/${Date.now()}-${Math.random()}`;
    // eslint-disable-next-line sonarjs/pseudo-random -- unique-name nonce for test isolation, not security-sensitive
    const b = `test/single-load/b/${Date.now()}-${Math.random()}`;
    assertSingleLoad(a);
    expect(() => assertSingleLoad(b)).not.toThrow();
  });
});
