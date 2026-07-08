/**
 * The carrier table — F1's column axis (docs/test-suite-v2/DESIGN.md).
 *
 * Every term×carrier cell is either implemented (and then obeys the term's declared
 * box discipline — P8) or an EXPLICIT `unsupported` entry. Absence is not a state:
 * the DR4 divergence hid in an absent cell.
 */
export interface CarrierRow {
  readonly carrier: "APair" | "AVector" | "AJSArray" | "AString" | "ADict" | "ABytevector";
  /** scheme source snippet minting a 3-element instance with stamped elements */
  readonly mint3: string;
  /** terms this carrier deliberately does NOT implement, with the teaching reason */
  readonly unsupported: readonly { term: string; reason: string }[];
}

export const CARRIERS: readonly CarrierRow[] = [
  { carrier: "APair", mint3: "(list (src 1) (src 2) (src 3))", unsupported: [] },
  { carrier: "AVector", mint3: "(vector (src 1) (src 2) (src 3))", unsupported: [] },
  {
    carrier: "AJSArray",
    mint3: "(borrow-array (src 1) (src 2) (src 3))", // via membrane fixture, not a scheme verb
    unsupported: [],
  },
  {
    carrier: "AString",
    mint3: '(string (src #\\a) (src #\\b) (src #\\c))',
    unsupported: [
      { term: "arrival/tagless-final/car", reason: "R7RS: car requires a pair; strict doors, loose projects" },
    ],
  },
  {
    carrier: "ADict",
    mint3: "(dict :a (src 1) :b (src 2) :c (src 3))",
    unsupported: [
      { term: "arrival/tagless-final/sort", reason: "dicts are unordered; no total order to sort by" },
      { term: "arrival/tagless-final/car", reason: "not a sequence" },
      { term: "arrival/tagless-final/cdr", reason: "not a sequence" },
    ],
  },
  {
    carrier: "ABytevector",
    mint3: "(bytevector (src 1) (src 2) (src 3))",
    unsupported: [
      { term: "arrival/tagless-final/map", reason: "R7RS has no bytevector-map; construct fresh" },
      { term: "arrival/tagless-final/filter", reason: "no bytevector filter in R7RS" },
      { term: "arrival/tagless-final/car", reason: "not a pair" },
      { term: "arrival/tagless-final/cdr", reason: "not a pair" },
    ],
  },
] as const;
