// normalizer/ladder — the shape ladder (docs/response-normalizer.md §6). OBSERVE-ONLY:
// this module watches raw JS values, accumulates a monotonically-widening per-tool shape
// assertion, and emits announce strings for the service header. It never transforms the
// value it is handed and never throws — doors belong to a later stage that operates only
// in the DECLARED zone (§3.5: "doors fire in the declared zone only"). A tool asserted
// here that later yields a conflicting kind is *information*, surfaced as an announcement,
// never an error (§3.5 audit NEW-2). Zero coupling to the parser/format-detection modules
// in this directory (csv/toon/python-literal/json) — this file reasons about value SHAPE
// only, never about text serialization.
//
// The ladder (§6):
//   unseen → singleton(T)  first response is one object/scalar
//          → vector(T)     any response with >1 element (OR AN ARRAY, any length —
//                           an array that reached observe() IS vector evidence, even a
//                           1-element array; the pre-normalizer raw value is what this
//                           module sees, so there is no "opportunistic bare presentation"
//                           to special-case around)
//          → nested(T)     an array-of-arrays appears; ceiling — deeper nesting stays here
// Never demotes (§6: "there is deliberately no demote heuristic — demotion IS the drift").
//
// `T` (kind + keys) widens monotonically too: a key is never dropped (§6), and a kind
// conflict (an object-asserted tool later yielding a scalar, §6.2's non-conformance case —
// which is a DOOR concern one stage up, not this one) is represented here by widening
// `kind` to `undefined` plus the `kindsSeen` union staying visible on `ToolShape`. That is
// the "widened marker" the task brief calls for: `kind` alone would erase which kinds were
// seen, so `kindsSeen` is the durable record and `kind` is its single-member projection.

export type Rung = "unseen" | "singleton" | "vector" | "nested";
export type Kind = "scalar" | "object" | "array";

export interface ToolShape {
  rung: Rung;
  /** Defined iff exactly one kind has ever been observed at this tool's current "element"
   *  level (the value itself at singleton, the array elements at vector/nested — §6:
   *  "element kind/keys are tracked, not the container's"). `undefined` means WIDENED —
   *  read `kindsSeen` for the full union; this is never "unknown", only "more than one". */
  kind?: Kind;
  /** Every kind ever observed at the element level. Monotonic — never shrinks. Size 1
   *  iff `kind` is defined; size >1 is the kind-widened state. */
  kindsSeen: Set<Kind>;
  /** Observed key union at the element level. No optional/required annotation (trust cut
   *  §2.1.2) — a key is either in this set (seen at least once) or not. Monotonic. */
  keys: Set<string>;
  /** Total observe() calls this tool has been through since its last wipe/creation. */
  observations: number;
}

export interface Announcement {
  tool: string;
  // "watching" (§6.1's opaque-text-progressively-detecting-format state) is part of the
  // announce vocabulary but is never emitted BY THIS MODULE — format detection is the
  // parser layer's concern (csv/toon/json/python-literal), not the shape ladder's. It
  // stays in the union for interface completeness with the header's shared vocabulary.
  kind: "promotion" | "first-shape" | "kind-widened" | "watching";
  text: string;
}

function kindOf(value: unknown): Kind {
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  return "scalar";
}

/** The "element facts" contributed by a set of leaf values — either the singleton value
 *  itself (one leaf), a vector's elements, or a nested array's flattened-one-level
 *  elements. Kind and keys are gathered uniformly regardless of which rung produced the
 *  leaves, because singleton/vector/nested all describe evidence about the SAME `T` the
 *  ladder tracks (§6: a later 1-element vector is the same T a singleton already named). */
function factsFromLeaves(leaves: unknown[]): { kindsSeen: Set<Kind>; keys: Set<string> } {
  const kindsSeen = new Set<Kind>();
  const keys = new Set<string>();
  for (const leaf of leaves) {
    const k = kindOf(leaf);
    kindsSeen.add(k);
    if (k === "object") {
      for (const key of Object.keys(leaf as Record<string, unknown>)) keys.add(key);
    }
  }
  return { kindsSeen, keys };
}

interface Evidence {
  evidenceRung: "singleton" | "vector" | "nested";
  kindsSeen: Set<Kind>;
  keys: Set<string>;
}

/** Reads one raw observe()d value into rung evidence + element facts. Never inspects
 *  history — the ladder class is what accumulates evidence across calls; this is a pure
 *  per-value reading. */
function analyze(value: unknown): Evidence {
  const topKind = kindOf(value);

  if (topKind !== "array") {
    // Singleton: the value itself is the one observed "item" (§6 Singleton(T)).
    const kindsSeen = new Set<Kind>([topKind]);
    const keys = new Set<string>();
    if (topKind === "object") {
      for (const key of Object.keys(value as Record<string, unknown>)) keys.add(key);
    }
    return { evidenceRung: "singleton", kindsSeen, keys };
  }

  const arr = value as unknown[];
  if (arr.length === 0) {
    // §6 "or an array" — an array is vector evidence regardless of length, including 0.
    // No elements means no element facts to contribute this call.
    return { evidenceRung: "vector", kindsSeen: new Set(), keys: new Set() };
  }

  const hasNestedArray = arr.some((el) => Array.isArray(el));
  if (!hasNestedArray) {
    const { kindsSeen, keys } = factsFromLeaves(arr);
    return { evidenceRung: "vector", kindsSeen, keys };
  }

  // Nested (array-of-arrays). §6's ceiling ("deeper nesting stays here") means T is
  // always the innermost item regardless of how many array levels wrap it — #(#(T)) is
  // the presentation shape at rung nested no matter whether the raw value was 2 or 5
  // levels deep. So the element facts here fully (recursively) flatten every array level
  // to reach the true leaves, rather than peeling exactly one level: peeling one level
  // would make a 3-deep array's "elements" be arrays themselves (kind "array"), which
  // would spuriously kind-conflict against a shallower 2-deep observation of the same
  // tool whose elements were objects — an artifact of flattening depth, not real T drift.
  const leaves = deepFlatten(arr);
  const { kindsSeen, keys } = factsFromLeaves(leaves);
  return { evidenceRung: "nested", kindsSeen, keys };
}

function deepFlatten(values: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const el of values) {
    if (Array.isArray(el)) out.push(...deepFlatten(el));
    else out.push(el);
  }
  return out;
}

const RUNG_RANK: Record<Rung, number> = { unseen: 0, singleton: 1, vector: 2, nested: 3 };

function rungAtRank(rank: number): Rung {
  if (rank <= 0) return "unseen";
  if (rank === 1) return "singleton";
  if (rank === 2) return "vector";
  return "nested";
}

function freshShape(): ToolShape {
  return { rung: "unseen", kind: undefined, kindsSeen: new Set(), keys: new Set(), observations: 0 };
}

function recomputeKind(shape: ToolShape): void {
  shape.kind = shape.kindsSeen.size === 1 ? [...shape.kindsSeen][0] : undefined;
}

function describeT(keys: Set<string>, kind: Kind | undefined): string {
  if (kind === "object") return `{${[...keys].toSorted((a, b) => a.localeCompare(b)).join(",")}}`;
  if (kind === undefined) return "mixed"; // the widened marker, rendered for the header
  return kind; // "scalar" | "array"
}

function describeShape(rung: Rung, keys: Set<string>, kind: Kind | undefined): string {
  const t = describeT(keys, kind);
  if (rung === "vector") return `#(${t})`;
  if (rung === "nested") return `#(#(${t}))`;
  return t;
}

interface Entry {
  shape: ToolShape;
  shapeHash: string;
}

/** Per-tool shape state, keyed by tool name, stamped with the shapeHash it was built
 *  under (§10.4). Pure in-memory, no persistence — the §8 cross-session store is a
 *  separate, out-of-scope layer this class knows nothing about. */
export class ShapeLadder {
  private readonly state = new Map<string, Entry>();
  // Removed-tool state, keyed by shapeHash (not name) — §10.4: "the hash is the cache
  // key, name may differ" on re-introduction.
  private readonly archive = new Map<string, ToolShape>();

  get(toolName: string): ToolShape | undefined {
    return this.state.get(toolName)?.shape;
  }

  observe(toolName: string, shapeHash: string, value: unknown): Announcement | null {
    let entry = this.state.get(toolName);
    if (entry?.shapeHash !== shapeHash) {
      // Either genuinely new, or a hash drift observed outside onListChanged. Same rule
      // either way (§10.4): a different hash means a different declared contract, so the
      // prior evidence does not carry over — fresh unseen, re-stamped with the new hash.
      entry = { shape: freshShape(), shapeHash };
      this.state.set(toolName, entry);
    }

    const shape = entry.shape;
    const prevRung = shape.rung;
    const prevKeysSnapshot = new Set(shape.keys);
    const prevKind = shape.kind;
    const prevKindsCount = shape.kindsSeen.size;
    const wasUnseen = prevRung === "unseen";
    const prevDescriptor = describeShape(prevRung, prevKeysSnapshot, prevKind);

    shape.observations += 1;

    const evidence = analyze(value);
    const targetRank = Math.max(RUNG_RANK[shape.rung], RUNG_RANK[evidence.evidenceRung]);
    const promoted = targetRank > RUNG_RANK[prevRung];
    if (promoted) shape.rung = rungAtRank(targetRank);

    for (const k of evidence.kindsSeen) shape.kindsSeen.add(k);
    for (const key of evidence.keys) shape.keys.add(key);
    recomputeKind(shape);

    if (wasUnseen) {
      // First-ever observation. This is true even when the first value is itself an
      // array (rung jumps straight to vector/nested) — there is no prior asserted shape
      // to be "promoted" from, so this is first-shape, not promotion (§6.1).
      return {
        tool: toolName,
        kind: "first-shape",
        text: `tool \`${toolName}\`: first observed shape ${describeShape(shape.rung, shape.keys, shape.kind)}.`,
      };
    }

    if (promoted) {
      const newDescriptor = describeShape(shape.rung, shape.keys, shape.kind);
      // Wording style per §6.1's promotion example. Only two upward edges exist past the
      // first observation (singleton→vector, vector→nested) — by construction this is at
      // most twice per tool (§7), whether reached step-by-step or in one skip-jump call.
      const guidance =
        shape.rung === "vector"
          ? "server saw this tool return a series. From now every response is a vector " +
            "(one result = 1-element vector). Use map/filter/reduce."
          : "server saw this tool return a series of series. From now every response is " +
            "nested #(#(T)) (a vector of vectors). Use map/filter/reduce at the outer " +
            "level, then again inside each inner vector.";
      return {
        tool: toolName,
        kind: "promotion",
        text: `tool \`${toolName}\`: shape ${prevDescriptor} → ${newDescriptor}\n  ${guidance}`,
      };
    }

    const widened = shape.kindsSeen.size > prevKindsCount;
    if (widened) {
      // Kind conflict, never a door in observe-only mode (§3.5 audit NEW-2): an object-
      // asserted tool yielding a scalar (or vice versa) is information the header
      // surfaces, not a thrown condition. The rung is untouched — this branch is only
      // reached when `promoted` was false.
      const kinds = [...shape.kindsSeen].toSorted((a, b) => a.localeCompare(b)).join(", ");
      return {
        tool: toolName,
        kind: "kind-widened",
        text:
          `tool \`${toolName}\`: kind widened — now observed as ${kinds}. Structure-from-` +
          "opportunistic-parse is information, not contract; no door, no throw.",
      };
    }

    // Pure key-union growth (or a fully-repeat observation) with no rung change and no
    // kind conflict. §7 says T-widening announces in general, but this module's
    // Announcement vocabulary has no distinct kind for "a key was added" (only
    // "kind-widened", reserved for a KIND conflict) — so key-only growth is surfaced
    // silently: `ToolShape.keys` already reflects it for any caller that reads state
    // directly, and the header is not spammed on every incrementally-widening key set.
    return null;
  }

  onListChanged(tools: Array<{ name: string; shapeHash: string }>): void {
    const present = new Set(tools.map((t) => t.name));

    // Anything currently tracked but absent from the new list is archived by shapeHash,
    // not dropped (§10.4: a removed tool's state survives keyed by its hash).
    for (const [name, entry] of this.state) {
      if (!present.has(name)) {
        this.archive.set(entry.shapeHash, entry.shape);
        this.state.delete(name);
      }
    }

    for (const { name, shapeHash } of tools) {
      const existing = this.state.get(name);
      if (existing) {
        if (existing.shapeHash !== shapeHash) {
          // Same name, different declared shape: wipe to fresh unseen (§10.4).
          this.state.set(name, { shape: freshShape(), shapeHash });
        }
        // Same hash: state survives untouched.
        continue;
      }
      // Not currently tracked under this name. If a prior tool (possibly a different
      // name) was archived under this exact hash, re-attach it — the hash is the cache
      // key, the name is incidental (§10.4). Otherwise leave it untracked; observe()
      // creates a fresh entry lazily on first call.
      const archived = this.archive.get(shapeHash);
      if (archived) {
        this.state.set(name, { shape: archived, shapeHash });
        this.archive.delete(shapeHash);
      }
    }
  }
}
