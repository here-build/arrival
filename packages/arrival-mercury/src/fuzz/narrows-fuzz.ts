/**
 * The schema-driven fuzzer's program synthesis + Law-N coverage check
 * (oracle-harness.md §4.4, reconciled against constitution §5.4/Law N). The value
 * generator lives in `./scheme-arbitrary.js`; the witness→consumer table lives in
 * `./predicate-consumers.js`; this module is the glue that turns one sampled value
 * into a `.scm` program and one harvested registry into a coverage verdict.
 *
 * Law A/T VIOLATION DETECTOR — a framing note, not a separate mechanism. The
 * constitution's Laws A/T/N are jointly at stake in every generated program: Law N
 * says the witness's narrowing must be TRUE (the compiled residual proves what it
 * claims); Law A says the consumer's residual selection reads only argument facts,
 * never result types; Law T's truthiness governs the `if`'s own branch selection. A
 * bug in any of these shows up as exactly one observable symptom — the interpreter
 * and the compiled artifact computing DIFFERENT VALUES for the same program. There
 * is no separate "Law A/T checker" to build: `runOracle`'s plain `agree` check
 * (interpreter ≡ compiled, oracle-harness.md §4.2) already IS the violation
 * detector, because a Law A/T/N violation has no other way to manifest than a value
 * (or error-class) mismatch on some input the narrowing claims to cover. This
 * module's `synthesizeSingleWitnessProgram` + the test file's `runOracle` call are
 * the whole mechanism; nothing else is added on top.
 */
import type { SchemeSample } from "./scheme-arbitrary.js";
import { renderSchemeLiteral } from "./scheme-arbitrary.js";

/**
 * `(let ((x <sampled-value>)) (if (<witness> x) (<consumer> x) 'skip))` —
 * oracle-harness.md §4.4's generator template, with the spec's informal "sampling x
 * from …" made literal: a `let`-bound name, evaluated exactly once, referenced from
 * both the witness test and the consumer call. (The doc's own template textually
 * substitutes the value twice; substituting a computed sub-expression twice would
 * be fine too under §2.2's "pure operands may double-evaluate," but a genuine
 * `let`-binding removes the question rather than relying on that license.)
 *
 * Both branches are meaningful: false → `'skip`, trivially equal on both sides
 * (proving nothing beyond "the interpreter and the compiled `if` agree on which
 * branch a false witness takes" — still worth asserting, cheaply); true → the
 * consumer call, the branch whose value the witness's narrowing is actually
 * supposed to license.
 */
export function synthesizeSingleWitnessProgram(witness: string, consumer: string, sample: SchemeSample): string {
  const lit = renderSchemeLiteral(sample);
  return `(let ((x ${lit})) (if (${witness} x) (${consumer} x) 'skip))`;
}

/**
 * Law N's mechanical coverage check (constitution §5.2, unconditional per
 * `docs/constitution.md:336`): every harvested narrows-flagged witness
 * must have at least one `PREDICATE_CONSUMERS` entry. Returns the witnesses with
 * NONE — empty ⇒ green; non-empty ⇒ the caller fails the build (no carve-out, no
 * "warn and continue").
 */
export function witnessesMissingConsumers(
  narrowsMembers: ReadonlySet<string>,
  predicateConsumers: Readonly<Record<string, readonly string[]>>,
): string[] {
  return [...narrowsMembers].filter((witness) => (predicateConsumers[witness] ?? []).length === 0).sort();
}
