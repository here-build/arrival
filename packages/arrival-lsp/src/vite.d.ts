// Vite-style raw asset imports.
//
// This lets us load TypeScript's stock lib/*.d.ts files directly via
// `import.meta.glob("typescript/lib/lib.*.d.ts", { query: "?raw", eager: true })`
// (filtered to the exact reference closure) instead of inlining sources or
// maintaining a generated barrel of individual imports.
//
// Consumers bundling with Vite (or Vitest) get the real file content as a
// string at bundle/transform time. The browser/worker entry of the type lens
// stays self-contained (no fs, no network) while the contents live only in
// the pinned `typescript` dep, not duplicated in our repo.
//
// Non-Vite bundlers will see a `?raw` specifier and need equivalent handling
// (or should use the Node entry + their own lib loading).
declare module "*?raw" {
  const content: string;
  export default content;
}

// Support for Vite's import.meta.glob used for direct asset loading in browser entry.
interface ImportMeta {
  glob: (pattern: string, options?: { eager?: boolean; query?: string | Record<string, any> }) => Record<string, any>;
}
