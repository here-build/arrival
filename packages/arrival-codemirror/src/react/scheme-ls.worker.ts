// The scheme language service worker entry — referenced by use-scheme-ide.ts
// via `new SharedWorker(new URL("./scheme-ls.worker.js", import.meta.url))`.
// All substance lives in the package (side-effectful module: attaches the
// server to this worker's ports, shared- and dedicated-flavored alike).
import "@here.build/arrival-type-lens/worker";
