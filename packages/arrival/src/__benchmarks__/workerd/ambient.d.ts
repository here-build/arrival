// Virtual `cloudflare:test` / `cloudflare:workers` modules exist only inside workerd
// (vitest.workerd.config.ts); these references give tsc/eslint their declarations.
/// <reference types="@cloudflare/vitest-pool-workers/types" />
/// <reference types="@cloudflare/workers-types" />
