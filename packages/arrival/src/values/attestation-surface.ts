// attestation-surface — the `/attestation` subpath's CURATED external face: the manifold's
// `s/*` boundary reads (`attest`/`isAttested`/`freshIfSingleton`). `attestDeep` is DEMOTED off
// this subpath (export-restructure, docs/plans/stage-c-corpse-deletion.md §"Export restructure")
// — it moves to `/reflect-internals` alongside the value classes it deep-walks, since its real
// consumers (arrival-provenance's verdict machinery) are reflection/verdict code, not manifold
// boundary authors. Nothing moves physically: `values/attestation.ts` is unchanged, still the
// definition site for all four; this file only narrows what this ONE subpath re-exports.
export { attest, isAttested, freshIfSingleton } from "./attestation.js";
