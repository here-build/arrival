// reference-graph — the §3.2 core data model (docs/working-proposals/symbol-define-
// static-program-validation.md, wave W3): an explicit graph where MISSING things are
// FIRST-CLASS NODES, built in one pass; every diagnostic is then a graph QUERY, never
// traversal-order reporting. Dagger shipped the other design (errors emitted in
// encounter order), got nonsensical dependency traces, and rewrote onto explicit
// graphs where a missing binding is itself a node (dagger#1614) — we start where they
// ended (the prior-art CHOSEN row).
//
// Cascade fusion (§3.1) falls out STRUCTURALLY instead of by bookkeeping: one
// `MissingConfigNode` aggregates every door it disables, each door aggregates every
// reference it explains — "group ReferenceNodes by the Missing* node their resolution
// path terminates in" is just reading the node. The causal chain is a PATH in the
// graph (`Reference → Door → owner / → MissingConfig`), not prose.
//
// Node kinds landed this wave: Reference, Binding, Door, MissingSymbol, MissingConfig.
// `MissingDepNode`/`MissingResourceNode` (§3.2) remain producer-less design shapes —
// `DoorCause.needs` carries only the `configuration` kind until the unrooted-capability
// policy is ruled (design doc §8 item 8); the graph grows additively then, exactly like
// `cause` grew onto `DoorSymbolDef`. CapabilityNode is carried as the door's `owner`
// display identity (`name @ capability` — the §3.1 display discipline).

import type { SourceLocation } from "../errors.js";
import type { DoorSymbolDef } from "../common/symbols/_bake.js";
import type { VocabularyEntry } from "./vocabulary.js";
import type { ReferenceOccurrence } from "./collect-references.js";

/** One free-name occurrence in the program — symbol × span × program order. */
export interface ReferenceNode {
  readonly name: string;
  readonly span: SourceLocation | undefined;
  /** Program order across ALL top-level forms — diagnostics sort by first site. */
  readonly order: number;
}

/** A vocabulary entry that resolves (value | keyword | macro | the program's own
 *  definitions) — referenced sites attach for future consumers (LSP nodes-at-span,
 *  mercury's FV∩exports closure); no diagnostic reads them this wave. */
export interface BindingNode {
  readonly name: string;
  readonly entry: VocabularyEntry | { readonly kind: "program" };
  readonly references: ReferenceNode[];
}

/** A bound door — carries its introspectable `DoorSymbolDef` (W0) and edges to the
 *  Missing* nodes its `cause.needs` names (W2's minted degradation doors). */
export interface DoorNode {
  readonly name: string;
  readonly door: DoorSymbolDef;
  /** The owning capability's display identity (`DoorCause.owner`), when stamped. */
  readonly owner: string | undefined;
  readonly needs: MissingConfigNode[];
  readonly references: ReferenceNode[];
}

/** A name NO vocabulary entry answers — first-class, ONE node per name. */
export interface MissingSymbolNode {
  readonly name: string;
  readonly references: ReferenceNode[];
}

/** An absent configuration key — first-class, ONE node per key; aggregates every
 *  door that key would cure (the §3.1 cascade-fusion grouping key). */
export interface MissingConfigNode {
  readonly key: string;
  readonly hint: string | undefined;
  readonly doors: DoorNode[];
}

export interface ReferenceGraph {
  /** Every reference, program order. */
  readonly references: readonly ReferenceNode[];
  readonly bindings: ReadonlyMap<string, BindingNode>;
  readonly doors: ReadonlyMap<string, DoorNode>;
  readonly missingSymbols: ReadonlyMap<string, MissingSymbolNode>;
  readonly missingConfigs: ReadonlyMap<string, MissingConfigNode>;
}

/**
 * Build the graph in one pass over the collected occurrences. `resolve` composes the
 * program's own definition names with the vocabulary (`validateProgram` supplies it);
 * `undefined` mints/extends the name's `MissingSymbolNode`.
 */
export function buildReferenceGraph(
  occurrences: readonly ReferenceOccurrence[],
  resolve: (name: string) => VocabularyEntry | { readonly kind: "program" } | undefined,
): ReferenceGraph {
  const references: ReferenceNode[] = [];
  const bindings = new Map<string, BindingNode>();
  const doors = new Map<string, DoorNode>();
  const missingSymbols = new Map<string, MissingSymbolNode>();
  const missingConfigs = new Map<string, MissingConfigNode>();

  const configNode = (key: string, hint: string | undefined): MissingConfigNode => {
    let node = missingConfigs.get(key);
    if (node === undefined) {
      node = { key, hint, doors: [] };
      missingConfigs.set(key, node);
    }
    return node;
  };

  for (const occ of occurrences) {
    const ref: ReferenceNode = { name: occ.name, span: occ.span, order: references.length };
    references.push(ref);

    const entry = resolve(occ.name);
    if (entry === undefined) {
      let node = missingSymbols.get(occ.name);
      if (node === undefined) {
        node = { name: occ.name, references: [] };
        missingSymbols.set(occ.name, node);
      }
      node.references.push(ref);
      continue;
    }
    if (entry.kind === "door") {
      let node = doors.get(occ.name);
      if (node === undefined) {
        node = {
          name: occ.name,
          door: entry.door,
          owner: entry.door.cause?.owner,
          needs: [],
          references: [],
        };
        doors.set(occ.name, node);
        for (const need of entry.door.cause?.needs ?? []) {
          // `configuration` is the only need kind with a producer (W0's narrowing).
          const cfg = configNode(need.key, need.hint);
          cfg.doors.push(node);
          node.needs.push(cfg);
        }
      }
      node.references.push(ref);
      continue;
    }
    let node = bindings.get(occ.name);
    if (node === undefined) {
      node = { name: occ.name, entry, references: [] };
      bindings.set(occ.name, node);
    }
    node.references.push(ref);
  }

  return { references, bindings, doors, missingSymbols, missingConfigs };
}
