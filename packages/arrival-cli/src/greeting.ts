/**
 * The greeting — THE static screenshot artifact (arrival-repl-viral-research.md §1.2,
 * §2.3): the gradient wordmark (wordmark.ts) plus ONE fetch-style identity line
 * (neofetch's genre — version · session facts · lens mode). Composed, not busy: no
 * onboarding wall-of-text here, deliberately (the doc's §7 tutorial genre is a
 * different artifact) — the greeting is the wordmark plus ONE identity line, period.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { colorMode, paint } from "./tints.js";
import type { Lens } from "./lens.js";
import { wordmark } from "./wordmark.js";

export interface GreetingFacts {
  readonly version: string;
  readonly capabilityCount: number;
  readonly lens: Lens;
}

/** `dist/greeting.js` → `../package.json` — resolved at runtime, not baked in at build
 *  time, so the printed version never drifts from what's actually installed. */
export async function readOwnVersion(): Promise<string> {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json");
    const raw = await readFile(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** The one fetch-style line: `arrival 0.1.0 — 2 capabilities armed · sugarcoat lens`. */
export function identityLine(facts: GreetingFacts, mode: ReturnType<typeof colorMode> = colorMode()): string {
  const caps = facts.capabilityCount === 0 ? "no capabilities armed" : `${facts.capabilityCount} capabilit${facts.capabilityCount === 1 ? "y" : "ies"} armed`;
  const lensLabel = facts.lens === "sugarcoat" ? "sugarcoat lens" : "classic lens";
  return paint(`arrival ${facts.version} — ${caps} · ${lensLabel} · ,lens to flip, ? for help`, "gutter", mode);
}

/** The composed greeting — wordmark lines + the identity line. `console.log` each
 *  element in order; kept as data (not a print function) so it's testable without a
 *  terminal. */
export function greetingLines(facts: GreetingFacts, mode: ReturnType<typeof colorMode> = colorMode()): string[] {
  return [...wordmark(mode), "", identityLine(facts, mode)];
}
