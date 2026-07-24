// Relative imports carry explicit .js extensions (house style, see the other
// foundations/arrival packages) so the EMITTED dist/*.d.ts resolves under nodenext
// consumers (sift). Extensionless specifiers type-check here (bundler-resolution
// consumers too) but silently drop every re-export for a nodenext consumer.
//
// Both tool tiers are value-shape, not a subclass stack: EnvCapability + per-verb
// baked `metadata` (description, dynamicDescription, isTool, risky — see tool.ts) is
// what the discovery tool reflects into its catalog + input schema off the RUN's own
// vocabulary (the run-reader door) — so the transport offloads the whole verb
// definition here. `defineMcpCapability` is the one authoring surface.
export * from "./defineMcpCapability.js";
// Value-shaped discovery tool: `new DiscoveryTool(name, capability, {description})` — the
// subclass-free shell that derives schema + catalog + eval from the one aggregating capability.
export * from "./DiscoveryTool.js";
// SessionRunState — the session's durable twin (statement log + first-class run cache),
// encode/decode, the cache-validity identity, and the interim config digest.
export * from "./session-run-state.js";
// Value-shaped mutation tool: `new ActionTool(name, {description, context, clusters})` — the
// subclass-free, FieldSpec-typed, receiver-dispatched, clustered batch tier; `defineCluster` +
// the refs/primitives back its action declarations.
export * from "./ActionTool.js";
// FieldSpec/Ref system (str/num/oneOf/defineRef/uuidShape/…) backing ActionTool context + props.
export * from "./refs.js";
// Typed error kernel (MCPError, withTimeout, size limits) used by ActionTool dispatch.
export * from "./errors.js";
// Wire DiscoveryTool/ActionTool onto the official @modelcontextprotocol/sdk Server (describe→list,
// call→call).
export * from "./sdk-adapter.js";
// serializeResult (used by sdk-adapter + the tool test-apps) + the UserlandCallToolResult type.
export * from "./dispatch.js";
export * from "./resources/index.js";
export * from "./store.js";
export { InMemorySessionStore as InMemoryArrivalSessionStore } from "./InMemorySessionStore.js";
export { tool } from "./tool.js";
