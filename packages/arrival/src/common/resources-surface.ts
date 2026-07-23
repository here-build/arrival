// resources-surface — the `/resources` subpath's CURATED external face: the port MODEL a
// capability author declares against (`Resource`/`AcquireCtx`/`port`). `Ref`/`ResourceCell`/
// `windDownAll` (resources.ts) are the RUNTIME MACHINERY only `common/capability.ts`'s bind
// loop consumes — never part of the authoring contract, so they stay off this subpath (still
// reachable internally by relative import from `./resources.js` directly; this file changes
// nothing about that module, it only narrows what `@inhuman.tools/arrival/resources` re-exports).
export type { Resource, AcquireCtx } from "./resources.js";
export { port } from "./resources.js";
