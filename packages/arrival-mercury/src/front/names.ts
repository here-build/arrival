/**
 * Re-export — the naming-ladder logic (`cleanName`/`nameCandidates`/`RESERVED`)
 * lives in exactly ONE place: `../walker/names.ts`. This file used to carry its
 * own COPY-AS-CHUNK duplicate of `cleanName`/`RESERVED`, and the two forks
 * DIVERGED (walker's `RESERVED` grew `static`/`enum`; this one didn't) — a
 * reserved word could reach the virtual-TS type lens (which imported THIS
 * copy, via `../type-emit/emit.ts`) while the real RUN emission (walker's
 * copy) escaped it correctly, silently degrading facts to holes. Glass and
 * artifact must read one naming ladder, not two — this file is kept only
 * because `./scheme-scope.ts` and `../type-emit/emit.ts` still import
 * `./names.js`; it carries no logic of its own, so it can never re-diverge.
 */
export { cleanName, nameCandidates } from "../walker/names.js";
