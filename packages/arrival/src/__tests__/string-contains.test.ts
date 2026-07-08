/**
 * `string-contains` / `string-contains?` — the substring-search pair carved into the
 * strings cluster (env/strings.ts). `string-contains` is SRFI-13 (index of the first
 * occurrence, or #f); `string-contains?` is the boolean predicate the same way `member?`
 * pairs with `member`. Both carry the lineage of the strings they searched — a derived
 * "this name contains 'Alloy'" decision over an evidence read must stay grounded
 * ("provenance everything; exclusion is not possible in teleological mode").
 *
 * Previously `string-contains` lived inline in inference-env.ts as a raw `.includes`
 * boolean (lineage erased) and `string-contains?` did not exist at all — an agent
 * reaching for it got `Unbound variable string-contains?`.
 */

import { describe, it, expect } from "vitest";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { initBridge } from "../bridge.js";
import { exec, execState } from "../eval/generator-exec.js";
import { inferenceEnv } from "../inference-env.js";
import { AString } from "../values/primitives/AString.js";
import { AExact } from "../values/primitives/AExact.js";
import { AValue } from "../values/primitives/AValue.js";

const stamped = (s: string, ...points: number[]) => new AString(CONSTANT_CTX, s, new Set(points));
const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
// Literal-string args carry no provenance, so the result comes back raw (a JS boolean
// or a bare SchemeExact); a provenanced input boxes it. Unwrap either shape.
const js = (x: unknown) => (x instanceof AValue ? x["arrival/toJS"]() : x);

describe("string-contains? — boolean predicate", () => {
  it("true when present, false when absent", async () => {
    await initBridge();
    const env = inferenceEnv.inherit("string-contains-pred");
    const [hit] = await exec('(string-contains? "research-Alloy.docx" "Alloy")', { env });
    const [miss] = await exec('(string-contains? "spoolsv.exe" "Alloy")', { env });
    expect(js(hit)).toBe(true);
    expect(js(miss)).toBe(false);
  });

  it("carries the provenance of the searched string (grounded decision)", async () => {
    await initBridge();
    const env = inferenceEnv.inherit("string-contains-pred-prov");
    env.set("name", stamped("Alloy.exe", 7));
    // execState (COMPLEX tier): asserts box discipline directly (RULINGS.md R1).
    const [r] = (await execState('(string-contains? name "Alloy")', { env })).values;
    expect(r).toBeInstanceOf(AValue);
    expect(sorted((r as AValue).provenance as Set<number>)).toEqual([7]);
  });
});

describe("string-contains — SRFI-13 index-or-#f", () => {
  it("returns the index of the first occurrence", async () => {
    await initBridge();
    const env = inferenceEnv.inherit("string-contains-idx");
    const [r] = (await execState('(string-contains "abcAlloy" "Alloy")', { env })).values;
    expect(r).toBeInstanceOf(AExact);
    expect(js(r)).toBe(3);
  });

  it("returns #f when absent (still truthy-correct: 0 is a real index)", async () => {
    await initBridge();
    const env = inferenceEnv.inherit("string-contains-miss");
    const [miss] = await exec('(string-contains "abc" "Alloy")', { env });
    const [zero] = await exec('(string-contains "Alloy" "Alloy")', { env });
    expect(js(miss)).toBe(false);
    expect(js(zero)).toBe(0); // index 0 — truthy in Scheme, #f is the only false
  });
});
