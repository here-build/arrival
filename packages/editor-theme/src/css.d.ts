// tsc (TS6) requires a declaration for side-effect CSS imports; the consumer's
// bundler (vite) is what actually resolves them.
declare module "*.css";
