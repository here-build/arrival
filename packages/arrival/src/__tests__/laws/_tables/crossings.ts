/**
 * The membrane crossing table — F3 (docs/test-suite-v2/DESIGN.md).
 *
 * ONE row per value type, BOTH directions, exit convention as a single column —
 * this table structurally cannot say "strings exit boxed, booleans exit raw"
 * without the contradiction appearing in a diff (P4). R1 RULED (2026-07-09,
 * docs/test-suite-v2/RULINGS.md): uniform plain-JS exit via the simple exec flow;
 * containers exit as lazy ref-tracking proxies (observationally plain JS — R9).
 * Exit LAW CELLS asserting these ruled forms go it.fails against today's
 * boxed-exit implementation until the uniform-exit change lands.
 */
export interface CrossingRow {
  readonly type: string;
  /** JS value entering scheme space (fromJS/jsToScheme) becomes… */
  readonly entryForm: string; // e.g. "AExact" | "AInexact" | "AString" | "borrowed AJSArray" | "VOID (refused, warn)"
  /** scheme value exiting to JS (toJS/schemeToJs) becomes… R1-gated. */
  /** ruled by R1: uniform plain-JS exit (containers = lazy ref-tracking proxy) */
  readonly exitForm: string;
  /** is a round-trip promised (P9)? if false, one-way projection only */
  readonly roundTrip: boolean;
}

export const CROSSINGS: readonly CrossingRow[] = [
  { type: "boolean", entryForm: "ABool", exitForm: "boolean", roundTrip: true },
  { type: "safe-int number", entryForm: "AExact", exitForm: "number", roundTrip: true },
  { type: "float number", entryForm: "AInexact", exitForm: "number", roundTrip: true },
  { type: "bigint", entryForm: "AExact", exitForm: "number in safe range, else bigint", roundTrip: false }, // normalizes to number in-range
  { type: "string", entryForm: "AString", exitForm: "string", roundTrip: true },
  { type: "null", entryForm: "ANil (nil)", exitForm: "null", roundTrip: false }, // known asymmetry, [fails]-ledgered
  { type: "undefined", entryForm: "AVoid", exitForm: "undefined", roundTrip: true },
  { type: "registered symbol (Symbol.for)", entryForm: "ASymbol", exitForm: "opaque symbol mapping (design pending, todo-ledgered)", roundTrip: false },
  { type: "unique symbol", entryForm: "VOID (refused, warn)", exitForm: "n/a", roundTrip: false },
  { type: "array", entryForm: "borrowed AJSArray (identity-cached)", exitForm: "raw source array", roundTrip: true },
  { type: "plain object", entryForm: "AJSObject (identity-cached, lazy)", exitForm: "raw source object", roundTrip: true },
  { type: "Uint8Array/ArrayBuffer/DataView", entryForm: "raw passthrough (named superset: FFI identity)", exitForm: "raw", roundTrip: true },
  // Promise: fromJS keeps the raw passthrough (the evaluator trampoline awaits it), but the
  // jsToScheme registry DOORS a bare Promise (jsToSchemeAsyncDoor) — a Promise VALUE inside a
  // structure never reaches the router: the holding container settles it lazily on entry read
  // (pending-entry.ts; the inbound-registry law owns those rows).
  { type: "Promise", entryForm: "raw at fromJS (trampoline awaits); jsToScheme DOORS — structure entries settle lazily", exitForm: "n/a", roundTrip: false },
  // Residual exotics (class instance / Map / Date / Error …): formerly a SILENT raw leak
  // through jsToScheme's exotic passthrough — now a borrowed AJSObject, loudly (warn), with
  // member reads through the interop policy and source-identity exit.
  { type: "exotic object (class instance)", entryForm: "borrowed AJSObject (warn — leak closed)", exitForm: "raw source instance", roundTrip: true },
  { type: "function (borrowed)", entryForm: "VOID (refused, warn)", exitForm: "region-scoped wrapper [INVERTS: reverse-membrane/P6]", roundTrip: false },
  { type: "proper list (scheme→JS only)", entryForm: "n/a", exitForm: "lazy array proxy (R9, one-way, P9)", roundTrip: false },
  { type: "dotted pair (scheme→JS only)", entryForm: "n/a", exitForm: "lazy array proxy, tail folded (R9, one-way, P9)", roundTrip: false },
  { type: "native vector (scheme→JS only)", entryForm: "n/a", exitForm: "lazy array proxy (R9, one-way, P9)", roundTrip: false },
  { type: "native dict (scheme→JS only)", entryForm: "n/a", exitForm: "lazy object proxy (R9, one-way, P9)", roundTrip: false },
] as const;

/** Forbidden crossings — every row must THROW with a teaching message (P5). */
export interface ViolationRow {
  readonly name: string;
  readonly act: string; // description of the violating call
  readonly door: RegExp; // the taught message
}

export const VIOLATIONS: readonly ViolationRow[] = [
  { name: "bare Promise into jsToScheme", act: "jsToScheme(ctx, Promise.resolve(1))", door: /bare Promise cannot cross/ },
  { name: "boxed value into fromJS", act: "fromJS(new AExact(...))", door: /already-boxed/ },
  { name: "wrapper re-entry into fromJS", act: "fromJS(fromJS({}))", door: /already-boxed/ },
  { name: "raw JS value into toJS", act: "toJS(42 as never)", door: /already JS/ },
  { name: "membrane write", act: "AJSObject.set(...)", door: /writes are banned/ },
  { name: "membrane delete", act: "AJSObject.delete(...)", door: /mutations are banned/ },
] as const;
