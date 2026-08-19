"""BFCL python reference-benchmark runner for the arrival-sampler.

BOUNDARY (read first): this package is NOT part of ``@inhuman.tools/arrival-sampler``. It is a
REFERENCE benchmark we run FOR the sampler — it measures each model's NATIVE python
function-calling ability (no arrival oracle, no Scheme, no constrained decoding) so the
sampler's later constrained runs have a baseline to be compared against. It is colocated in
``scripts/`` purely for convenience and imports NONE of the sampler's TypeScript. It reads
exactly one artifact from the package: ``rosters.json``.

Data + scoring provenance:
  • dataset: github.com/ShishirPatil/gorilla — berkeley-function-call-leaderboard,
    bfcl_eval/data (commit 6ea57973c7a6097fd7c5915698c54c17c5b1b6c8), four python AST tracks.
  • scoring: a faithful port of inhuman/examples/intent-eval/src/bfcl/bfcl-score.ts so the
    python baseline uses the SAME AST-matching rules as the TS constrained runs.
"""
