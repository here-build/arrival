/**
 * The extract fixture corpus (G1, 2026-07-15) — DUAL-USE by design (§2g):
 *
 *   1. T4 (verdict channel) and T7a (render) consume each row's `expected`
 *      circuit as their test INPUT — they build fixture-first, before extract
 *      exists.
 *   2. T2's J1 gate asserts `matches(extractProgram(row.source), row.expected)`
 *      — the SAME artifact grounds both sides, so fixture drift is impossible
 *      by construction.
 *
 * Patterns are SITE-BLIND (NodeIds are mint-order, unknowable by hand): they
 * assert structure, kinds, heads, keys, integrity — never ids. `{kind:"*"}`
 * wildcards a subtree.
 *
 * The seed rows are the ADVERSARIAL canon — each one is a forge that was
 * actually found and killed (session history, provenance-by-perturbation.md §3),
 * frozen here as a permanent guard:
 *   row 1  guard-swap        (the FATAL v2 forge — probe alone said content)
 *   row 2  named-helper      (Fable audit reopening — beta-reduction's reason)
 *   row 3  hidden-const fold (longcat ≥2-agree — "wind collapses clean" killed)
 *   rows 4-5 genuine content / plain fuse (the innocent twins the forges imitate)
 */
import type { CollapseKind, Integrity, StaticProv } from "../../model/static-prov.js";

// ── the pattern language ────────────────────────────────────────────────────────

export type ProvPattern =
  | { readonly kind: "*" }
  | { readonly kind: "input"; readonly name?: string }
  | { readonly kind: "const" }
  | { readonly kind: "mint"; readonly head?: string; readonly integrity?: Integrity }
  | { readonly kind: "fused"; readonly sources: readonly ProvPattern[] }
  | { readonly kind: "mux"; readonly key?: string | number | null; readonly source: ProvPattern }
  | {
      readonly kind: "build";
      readonly ctor?: "pair" | "vector" | "dict";
      readonly parts?: readonly { readonly key: string | number; readonly prov: ProvPattern }[];
    }
  | { readonly kind: "string"; readonly runs: readonly ProvPattern[] }
  | { readonly kind: "choice"; readonly guards: readonly ProvPattern[]; readonly alts: readonly ProvPattern[] }
  | {
      readonly kind: "fan";
      readonly collection: ProvPattern;
      readonly body: ProvPattern;
      readonly collapse?: CollapseKind;
    }
  | { readonly kind: "opaque"; readonly reason?: string };

/** Structural match, site-blind. Returns null on match or a human-readable
 *  mismatch path (for the J1 gate's failure output). */
export function mismatch(prov: StaticProv, pat: ProvPattern, path = "$"): string | null {
  if (pat.kind === "*") return null;
  if (prov.kind !== pat.kind) return `${path}: expected ${pat.kind}, got ${prov.kind}`;
  switch (pat.kind) {
    case "input":
      return pat.name !== undefined && prov.kind === "input" && prov.name !== pat.name
        ? `${path}: input name ${prov.name} ≠ ${pat.name}`
        : null;
    case "const":
      return null;
    case "mint": {
      if (prov.kind !== "mint") return `${path}: not mint`;
      if (pat.head !== undefined && prov.head !== pat.head) return `${path}: mint head ${prov.head} ≠ ${pat.head}`;
      if (pat.integrity !== undefined && prov.integrity !== pat.integrity)
        return `${path}: mint integrity ${prov.integrity} ≠ ${pat.integrity}`;
      return null;
    }
    case "fused": {
      if (prov.kind !== "fused") return `${path}: not fused`;
      if (prov.sources.length !== pat.sources.length)
        return `${path}: fused arity ${prov.sources.length} ≠ ${pat.sources.length}`;
      for (let i = 0; i < pat.sources.length; i++) {
        const m = mismatch(prov.sources[i]!, pat.sources[i]!, `${path}.sources[${i}]`);
        if (m) return m;
      }
      return null;
    }
    case "mux": {
      if (prov.kind !== "mux") return `${path}: not mux`;
      if (pat.key !== undefined && prov.key !== pat.key)
        return `${path}: mux key ${String(prov.key)} ≠ ${String(pat.key)}`;
      return mismatch(prov.source, pat.source, `${path}.source`);
    }
    case "build": {
      if (prov.kind !== "build") return `${path}: not build`;
      if (pat.ctor !== undefined && prov.ctor !== pat.ctor) return `${path}: ctor ${prov.ctor} ≠ ${pat.ctor}`;
      if (pat.parts !== undefined) {
        if (prov.parts.length !== pat.parts.length)
          return `${path}: build arity ${prov.parts.length} ≠ ${pat.parts.length}`;
        for (let i = 0; i < pat.parts.length; i++) {
          const pp = pat.parts[i]!;
          const vp = prov.parts[i]!;
          if (vp.key !== pp.key) return `${path}.parts[${i}]: key ${String(vp.key)} ≠ ${String(pp.key)}`;
          const m = mismatch(vp.prov, pp.prov, `${path}.parts[${i}]`);
          if (m) return m;
        }
      }
      return null;
    }
    case "string": {
      if (prov.kind !== "string") return `${path}: not string`;
      if (prov.runs.length !== pat.runs.length)
        return `${path}: run count ${prov.runs.length} ≠ ${pat.runs.length}`;
      for (let i = 0; i < pat.runs.length; i++) {
        const m = mismatch(prov.runs[i]!, pat.runs[i]!, `${path}.runs[${i}]`);
        if (m) return m;
      }
      return null;
    }
    case "choice": {
      if (prov.kind !== "choice") return `${path}: not choice`;
      if (prov.guards.length !== pat.guards.length)
        return `${path}: guard count ${prov.guards.length} ≠ ${pat.guards.length}`;
      if (prov.alts.length !== pat.alts.length)
        return `${path}: alt count ${prov.alts.length} ≠ ${pat.alts.length}`;
      for (let i = 0; i < pat.guards.length; i++) {
        const m = mismatch(prov.guards[i]!, pat.guards[i]!, `${path}.guards[${i}]`);
        if (m) return m;
      }
      for (let i = 0; i < pat.alts.length; i++) {
        const m = mismatch(prov.alts[i]!, pat.alts[i]!, `${path}.alts[${i}]`);
        if (m) return m;
      }
      return null;
    }
    case "fan": {
      if (prov.kind !== "fan") return `${path}: not fan`;
      if (pat.collapse !== undefined && prov.collapse !== pat.collapse)
        return `${path}: collapse ${prov.collapse} ≠ ${pat.collapse}`;
      const c = mismatch(prov.collection, pat.collection, `${path}.collection`);
      if (c) return c;
      return mismatch(prov.body, pat.body, `${path}.body`);
    }
    case "opaque": {
      if (prov.kind !== "opaque") return `${path}: not opaque`;
      return pat.reason !== undefined && !prov.reason.startsWith(pat.reason)
        ? `${path}: reason ${prov.reason} !startsWith ${pat.reason}`
        : null;
    }
  }
}

export const matches = (prov: StaticProv, pat: ProvPattern): boolean => mismatch(prov, pat) === null;

// ── the rows ────────────────────────────────────────────────────────────────────

export interface FixtureRow {
  readonly name: string;
  readonly source: string;
  readonly expected: ProvPattern;
  /** What the row guards — cite the forge or the property. */
  readonly why: string;
}

const input = (name: string): ProvPattern => ({ kind: "input", name });
const muxOf = (key: string, name: string): ProvPattern => ({ kind: "mux", key, source: input(name) });

export const FIXTURE_CORPUS: readonly FixtureRow[] = [
  {
    name: "guard-swap forge",
    source: `(if (< (:v e) 1000) "SAFE" (number->string (:v e)))`,
    expected: {
      kind: "choice",
      guards: [{ kind: "fused", sources: [muxOf("v", "e"), { kind: "const" }] }],
      alts: [{ kind: "const" }, { kind: "fused", sources: [muxOf("v", "e")] }],
    },
    why: "The FATAL v2 forge: probe alone certifies the flipped branch; the literal alt must stay a visible const so the static leg refuses content.",
  },
  {
    name: "named-helper forge",
    source: `(define (f x) (if (> x 5) "SAFE" x))\n(f (:score e))`,
    expected: {
      kind: "choice",
      guards: [{ kind: "fused", sources: [muxOf("score", "e"), { kind: "const" }] }],
      alts: [{ kind: "const" }, muxOf("score", "e")],
    },
    why: "The Fable-audit reopening: without beta-reduction the helper call reads as opaque forwarding and the guard's literal hides. Beta must inline f's body with x bound to the argument's attribution.",
  },
  {
    name: "hidden-const fold (longcat)",
    source: `(fold (lambda (acc x) (if (eq? x "s") "FABRICATED" x)) "" (:xs e))`,
    expected: {
      kind: "fan",
      collection: muxOf("xs", "e"),
      collapse: "lowered",
      body: {
        kind: "choice",
        guards: [{ kind: "*" }],
        alts: [{ kind: "const" }, { kind: "*" }],
      },
    },
    why: "The ≥2-agree fold-collapse forge: a const behind an if inside a fold body. Collapse must stay 'lowered' (never combine) and the body's const must stay visible.",
  },
  {
    name: "genuine content",
    source: `(number->string (:v e))`,
    expected: { kind: "fused", sources: [muxOf("v", "e")] },
    why: "The innocent twin of row 1's else-branch: pure transformation of evidence is content — fused over the projection, no const anywhere.",
  },
  {
    name: "plain fuse",
    source: `(+ (:a e) (:b e))`,
    expected: { kind: "fused", sources: [muxOf("a", "e"), muxOf("b", "e")] },
    why: "⊗ baseline: both evidence projections contribute; arity and order preserved.",
  },
];
