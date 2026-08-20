/**
 * Host pretreat — mercury compiles generated scheme and does not name domain
 * extensions. A `.foo` file is enough to prove the seam.
 */
import { describe, expect, it } from "vitest";

import { buildProject } from "../build/project.js";
import { RUNNER_PLANE } from "./runner-plane.js";

describe("buildProject pretreat", () => {
  it("compiles a host-pretreat extension as an ordinary scheme module", async () => {
    const result = await buildProject(
      {
        "answer.foo": "ignored bytes",
        "main.scm": `(define n (require "answer.foo"))\nn`,
      },
      {
        capabilities: RUNNER_PLANE,
        pretreat: {
          ".foo": () => `(lambda () 42)`,
        },
      },
    );
    expect(result.skippedFiles).toEqual([]);
    const answer = result.files.find((f) => f.path === "answer.ts");
    expect(answer?.content).toMatch(/export default function/);
    const main = result.files.find((f) => f.path === "main.ts");
    expect(main?.content).toContain("answer");
  });

  it("skips an unregistered domain extension as unrecognized", async () => {
    const result = await buildProject(
      { "greet.prompt": "---\nmodel: x\n---\nHi" },
      { capabilities: RUNNER_PLANE },
    );
    expect(result.skippedFiles).toEqual(["greet.prompt"]);
    expect(result.warnings.some((w) => w.code === "build/unrecognized-ext")).toBe(true);
  });
});
