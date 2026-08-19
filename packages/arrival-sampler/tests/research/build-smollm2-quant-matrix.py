# build-smollm2-quant-matrix.py — assemble the 6 local SmolLM2 quant artifacts
# the quant-ranking study references: SmolLM2-{135M,360M}-Instruct-{q8,q4,q2}.
#
# q8 (model_quantized.onnx) and q4 (model_q4.onnx) ship pre-built in the HF repos,
# so those dirs are assembled by COPYING the stock ONNX + tokenizer/config.
# q2 (model_q2.onnx) is NOT shipped — generated here via onnxruntime
# MatMulNBits weight-only quantization at bits=2 from the fp16 graph.
#
# Layout produced (transformers.js localModelPath convention):
#   models/<Repo>-<q>/onnx/model_quantized.onnx   (q8)
#   models/<Repo>-<q>/onnx/model_q4.onnx          (q4)
#   models/<Repo>-<q>/onnx/model_q2.onnx          (q2)
#   models/<Repo>-<q>/{config.json,tokenizer*.json,vocab.json,merges.txt,...}
#
# Usage: uv run --with onnx --with onnxruntime --with huggingface_hub \
#          python build-smollm2-quant-matrix.py

import shutil
import sys
import tempfile
from pathlib import Path

from huggingface_hub import snapshot_download

REPOS = ["HuggingFaceTB/SmolLM2-135M-Instruct", "HuggingFaceTB/SmolLM2-360M-Instruct"]
MODELS_DIR = (Path(__file__).parent / ".." / "models").resolve()

# onnx files we copy verbatim per dtype
COPY_MAP = {
    "q8": "model_quantized.onnx",
    "q4": "model_q4.onnx",
}


def copy_meta(src: Path, dst: Path) -> None:
    for f in src.iterdir():
        if f.is_file() and f.suffix in {".json", ".txt"}:
            shutil.copy(f, dst / f.name)


def assemble_copy(repo: str, src: Path, q: str, onnx_name: str) -> None:
    short = repo.split("/")[-1]
    out = MODELS_DIR / f"{short}-{q}"
    onnx_out = out / "onnx"
    onnx_out.mkdir(parents=True, exist_ok=True)
    copy_meta(src, out)
    src_onnx = src / "onnx" / onnx_name
    # external-data sidecar, if present
    for cand in (onnx_name, onnx_name + "_data", onnx_name + ".data"):
        p = src / "onnx" / cand
        if p.exists():
            shutil.copyfile(p.resolve(), onnx_out / cand)
    size = sum(f.stat().st_size for f in onnx_out.iterdir())
    print(f"  [{q}] {out.name}/onnx/{onnx_name} — {size/1e6:.1f} MB")


def assemble_q2(repo: str, src: Path, bits: int = 2, block_size: int = 32) -> None:
    import onnx
    from onnxruntime.quantization.matmul_nbits_quantizer import (
        DefaultWeightOnlyQuantConfig,
        MatMulNBitsQuantizer,
    )

    short = repo.split("/")[-1]
    out = MODELS_DIR / f"{short}-q{bits}"
    onnx_out = out / "onnx"
    onnx_out.mkdir(parents=True, exist_ok=True)
    copy_meta(src, out)

    # materialize fp16 graph (hub cache is symlinks; onnx.load refuses symlinked external data)
    scratch = Path(tempfile.mkdtemp(prefix=f"q{bits}-{short}-"))
    base = "model_fp16.onnx"
    for name in (base, base + "_data", base + "_data_1"):
        p = src / "onnx" / name
        if p.exists():
            shutil.copyfile(p.resolve(), scratch / name)

    model = onnx.load(str(scratch / base))
    config = DefaultWeightOnlyQuantConfig(block_size=block_size, bits=bits)
    quant = MatMulNBitsQuantizer(model, algo_config=config)
    quant.process()
    qmodel = quant.model.model

    dst = onnx_out / f"model_q{bits}.onnx"
    onnx.save_model(qmodel, str(dst), save_as_external_data=True, location=f"model_q{bits}.onnx_data")
    size = sum(f.stat().st_size for f in onnx_out.iterdir())
    print(f"  [q{bits}] {out.name}/onnx/model_q{bits}.onnx — {size/1e6:.1f} MB")


def main() -> int:
    for repo in REPOS:
        print(f"=== {repo}", flush=True)
        print("  downloading onnx + tokenizer/config…", flush=True)
        src = Path(
            snapshot_download(
                repo,
                allow_patterns=[
                    "onnx/model_quantized.onnx*",
                    "onnx/model_q4.onnx*",
                    "onnx/model_fp16.onnx*",
                    "*.json",
                    "*.txt",
                ],
            )
        )
        for q, onnx_name in COPY_MAP.items():
            assemble_copy(repo, src, q, onnx_name)
        try:
            assemble_q2(repo, src)
        except Exception as e:  # noqa: BLE001
            print(f"  [q2] FAILED: {type(e).__name__}: {e}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
