/**
 * The registry → grammar reduction: `Contract.narrows` rows to the KEY SET the
 * narrowing-form grammar consumes (`EmitTypesOptions.narrowsMembers`).
 *
 * Consumed here only as names — the `witness` sub-field is Law N's CI concern
 * (`assertNarrowsWitnessed`, run inside every harvest) and the schema-driven
 * fuzzer's row generator, never the grammar's. Colocated with the consumer so
 * the integration seam (service-core threading `emitTypes(src, { narrowsMembers:
 * narrowsMembersOf(registry) })`) needs no knowledge of row internals.
 */
import type { EmitRegistry } from "../registry/index.js";

/** Every harvested symbol whose Contract carries a Law-N `narrows` declaration. */
export function narrowsMembersOf(registry: EmitRegistry): ReadonlySet<string> {
  const out = new Set<string>();
  for (const name of registry.names) {
    if (registry.lookup(name)?.narrows !== undefined) out.add(name);
  }
  return out;
}
