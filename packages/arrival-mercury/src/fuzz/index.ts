/** The schema-driven fuzzer (oracle-harness.md §4.4; constitution §5.4/Law N). */
export { PREDICATE_CONSUMERS } from "./predicate-consumers.js";
export { synthesizeSingleWitnessProgram, witnessesMissingConsumers } from "./narrows-fuzz.js";
export { arbitrarySchemeValue, renderSchemeLiteral, type SchemeSample } from "./scheme-arbitrary.js";
