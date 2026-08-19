# subset_filter.py — write a "first-N-ids-per-leaf-category" run-id filter for a SUBSET BFCL run.
#
# `./run.sh subset <model> <N> <group...>` calls this to exercise EVERY category cheaply (coverage, not
# full counts): expand each group/category arg to its leaf categories, take the first N entry ids of each
# (deterministic upstream order), and write {category: [ids...]} to the EXACT path BFCL reads
# (TEST_IDS_TO_GENERATE_PATH, derived from BFCL_PROJECT_ROOT — robust to CWD drift). Prints the
# space-joined leaf-category list on stdout so the caller can pass it straight to `generate --run-ids`.
#
#   python subset_filter.py <N> <group-or-category>...
#
# A group name (e.g. non_live, live, memory, multi_turn, all_scoring) expands via TEST_COLLECTION_MAPPING;
# anything else is treated as a literal leaf category. web_search/agentic leaves are dropped unless asked
# for by name (they need a SERPAPI key).

from __future__ import annotations

import json
import sys

from bfcl_eval.constants.category_mapping import TEST_COLLECTION_MAPPING
from bfcl_eval.constants.eval_config import TEST_IDS_TO_GENERATE_PATH
from bfcl_eval.utils import load_dataset_entry

# Leaves we skip when they arrive via a GROUP expansion (need a real SERPAPI_API_KEY / external calls).
_SKIP_IN_GROUP = {"web_search_base", "web_search_no_snippet"}


def expand(token: str) -> list[str]:
    """A group name → its leaf categories (skipping web_search); else the token as a literal leaf."""
    if token in TEST_COLLECTION_MAPPING:
        return [c for c in TEST_COLLECTION_MAPPING[token] if c not in _SKIP_IN_GROUP]
    return [token]


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: subset_filter.py <N> <group-or-category>...", file=sys.stderr)
        return 2
    n = int(sys.argv[1])
    # Preserve order, dedupe, across all requested groups/categories.
    leaves: list[str] = []
    for tok in sys.argv[2:]:
        for cat in expand(tok):
            if cat not in leaves:
                leaves.append(cat)

    filt: dict[str, list[str]] = {}
    for cat in leaves:
        entries = load_dataset_entry(cat)
        ids = [e["id"] for e in entries[:n]]
        if ids:
            filt[cat] = ids

    with open(TEST_IDS_TO_GENERATE_PATH, "w") as fh:
        json.dump(filt, fh, indent=2)

    total = sum(len(v) for v in filt.values())
    print(f"[subset] wrote {total} ids across {len(filt)} categories to {TEST_IDS_TO_GENERATE_PATH}", file=sys.stderr)
    # stdout: the leaf categories that actually have ids, COMMA-joined — the form BFCL's --test-category
    # `handle_multiple_input` callback splits on. (A space-joined string arrives as ONE invalid category at
    # the evaluate step: `Invalid test category name provided: simple_python simple_java …`. generate ignores
    # --test-category under --run-ids, but evaluate parses it, so comma is required.)
    print(",".join(filt.keys()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
