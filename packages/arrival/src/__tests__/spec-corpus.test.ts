// Grammar conformance corpus runner — the ONLY implementation-specific piece of the
// language-portable suite in spec/corpus/ (see its README for the record format, the
// AST canonicalization convention, the eval value convention, and the error taxonomy).
// A future Python/Rust reader port ships its own thin runner over the same JSONL.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execState } from "../eval/generator-exec.js";
import { parse } from "../reader/parse.js";
import { AJSObject } from "../values/primitives/AJSObject.js";
import { AVector } from "../values/primitives/AVector.js";
import { ADict } from "../values/primitives/ADict.js";
import { APair } from "../values/primitives/APair.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { AString } from "../values/primitives/AString.js";
import { ABool } from "../values/primitives/ABool.js";
import { AExact } from "../values/primitives/AExact.js";
import { AInexact } from "../values/primitives/AInexact.js";
import { is_nil } from "../eval/guards.js";
import { theVoid } from "../values/primitives/AVoid.js";
import { ANil } from "../values/primitives/ANil.js";

interface CorpusCase {
  name: string;
  mode: "read" | "eval";
  input: string;
  expect: { ast?: string; value?: unknown; error?: string };
}

const corpusDir = fileURLToPath(new URL("../../spec/corpus/", import.meta.url));
const corpusFiles = readdirSync(corpusDir).filter((f) => f.endsWith(".jsonl"));

function loadCases(file: string): CorpusCase[] {
  return readFileSync(join(corpusDir, file), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CorpusCase);
}

/** Canonical AST rendering — the corpus README's convention. Recursive (String(pair)
 *  would render an embedded literal node through its own print protocol, which is the
 *  VALUE face, not the canonical AST face). */
function renderAst(v: unknown): string {
  if (ADict.isDictLiteral(v)) {
    return `{${v.literalForms.map(renderAst).join(" ")}}`;
  }
  if (v instanceof AVector) {
    const body = v.__vector__.map(renderAst).join(" ");
    return v.evalElements ? `[${body}]` : `#(${body})`;
  }
  if (v instanceof APair) {
    const parts: string[] = [];
    let node: unknown = v;
    while (node instanceof APair) {
      parts.push(renderAst(node.car));
      node = node.cdr;
    }
    const tail = (node instanceof ANil) ? "" : ` . ${renderAst(node)}`;
    return `(${parts.join(" ")}${tail})`;
  }
  if (v instanceof AString) return JSON.stringify(v.toString());
  if (v instanceof ANil) return "()";
  return String(v);
}

/** Eval-result fold — the corpus README's value convention. */
function toJson(v: unknown): unknown {
  if (v == null || v instanceof ANil || v === theVoid) return null;
  if (v instanceof AExact || v instanceof AInexact) return Number(v.valueOf());
  if (v instanceof ABool) return Boolean(v.valueOf());
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (v instanceof AString) return v.toString();
  if (v instanceof ASymbol) {
    return { $sym: typeof v.__name__ === "string" ? v.__name__ : String(v.valueOf()) };
  }
  if (v instanceof AVector) return v.__vector__.map(toJson);
  if (v instanceof AJSObject || v instanceof ADict) {
    return Object.fromEntries(v.keys().map((k) => [k, toJson(v.get(k))]));
  }
  if (typeof v === "object" && !(v instanceof APair)) {
    // the raw Record `(dict …)` returns
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, toJson(x)]));
  }
  throw new Error(`corpus toJson: unfoldable value ${String(v)} — keep corpus expectations JSON-shaped`);
}

/** The stable error class of a thrown error — own `.code`, or the nearest one up the
 *  cause chain (eval wraps parse/throw sites in ArrivalError layers). */
function errorClass(e: unknown): string | undefined {
  for (let cur = e; cur instanceof Error; cur = cur.cause as Error | undefined) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

for (const file of corpusFiles) {
  describe(`spec corpus — ${file}`, () => {
    for (const c of loadCases(file)) {
      it(c.name, async () => {
        const run = async (): Promise<unknown> => {
          if (c.mode === "read") {
            const datums = await parse(c.input);
            return renderAst(datums.at(-1));
          }
          // execState (COMPLEX tier): `toJson`'s canonicalization discriminates by BOXED
          // type (ASymbol vs AString vs AExact, …) — a boxed-state concern (RULINGS.md
          // R1), not the SIMPLE tier's plain-JS exit (whose apostrophe-prefixed symbol
          // string is indistinguishable from a real string starting with `'`).
          const { values } = await execState(c.input);
          return toJson(values.at(-1));
        };
        if (c.expect.error !== undefined) {
          let failed: unknown = undefined;
          let ok = false;
          try {
            await run();
          } catch (e) {
            ok = true;
            failed = e;
          }
          expect(ok, `expected ${c.expect.error}, but ${c.mode} succeeded`).toBe(true);
          if (c.expect.error !== "*") {
            expect(errorClass(failed), `error message: ${String(failed)}`).toBe(c.expect.error);
          }
          return;
        }
        const actual = await run();
        if (c.expect.ast !== undefined) {
          expect(actual).toBe(c.expect.ast);
        } else {
          expect(actual).toEqual(c.expect.value);
        }
      });
    }
  });
}
