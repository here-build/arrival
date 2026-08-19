#!/usr/bin/env python
"""Thin wrapper around the official ``bfcl`` CLI that first registers our LM Studio
(OpenAI-compatible) models, then delegates verbatim to the upstream Typer app.

Usage is identical to ``bfcl`` — every flag passes straight through:

    python bfcl_lmstudio.py generate  --model arch-agent-3b --test-category simple_python --skip-server-setup
    python bfcl_lmstudio.py evaluate  --model arch-agent-3b --test-category simple_python
    python bfcl_lmstudio.py models
    python bfcl_lmstudio.py test-categories

The ONLY thing this adds over ``bfcl`` is the in-place registration of our served-id model rows
(see register_lmstudio_models.py) so ``--model arch-agent-3b`` resolves. It changes no upstream
behaviour and patches no upstream file — the gorilla submodule stays pristine.

Endpoint is configured purely by environment (read by ``OpenAICompletionsHandler``):
    OPENAI_BASE_URL=http://localhost:1234/v1   OPENAI_API_KEY=lm-studio
Set those in scripts/bfcl_official/.env (BFCL auto-loads it from BFCL_PROJECT_ROOT) or export
them. See README.md.
"""

from __future__ import annotations

import sys

from register_lmstudio_models import register


def main() -> None:
    added = register()
    # A one-line provenance note to stderr so a run log records what was injected (does not
    # pollute the table the CLI prints to stdout).
    print(
        f"[bfcl_lmstudio] registered {len(added)} LM Studio model rows "
        f"(OpenAI-compatible chat/FC via OPENAI_BASE_URL)",
        file=sys.stderr,
    )
    # Import the upstream Typer app AFTER registration. The CLI module imported
    # MODEL_CONFIG_MAPPING by-reference at its own import time; register() mutated that same
    # dict object in place, so the additions are already visible to it.
    from bfcl_eval.__main__ import cli

    cli()


if __name__ == "__main__":
    main()
