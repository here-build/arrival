// model-discover.test.ts — multi-source GGUF discovery, filesystem-driven and MODEL-FREE. We build temp dirs
// that mimic the LM Studio / Ollama on-disk layouts (including every edge case verified on disk: an imported
// `<name>.gguf` DIRECTORY, an `mmproj-*` projector, a sharded set, a multi-quant repo, a partial download with
// no first shard) and assert that discovery picks the right files, the quant ladder collapses variants, the
// Ollama manifest→blob indirection resolves, and cross-source id collisions are precedence-namespaced.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverModels, listModelIds, resolveModelPath, type Source } from "../../src/runners/server/model-resolve.js";

let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "discover-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a file (with arbitrary content), creating parent dirs — so `a/b.gguf/c.gguf` makes `b.gguf` a DIR. */
function write(rel: string, content = "x"): string {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

/** Map discovered models to `id → chosen-file basename`, for compact assertions. */
function idToBase(models: { id: string; path: string }[]): Record<string, string> {
  return Object.fromEntries(models.map((m) => [m.id, path.basename(m.path)]));
}

describe("discoverModels — LM Studio store", () => {
  // One LM Studio store with every edge case under it.
  function seedLmStudio(): Source {
    const dir = path.join(root, "lmstudio");
    // imported model: the OUTER `<name>.gguf` is a directory holding the real gguf
    write("lmstudio/katanemo/Arch-Agent-1.5B.gguf/Arch-Agent-1.5B.gguf");
    // multi-quant repo (collapses via the ladder)
    write("lmstudio/mradermacher/Hammer2.1-3b-GGUF/Hammer2.1-3b.Q4_K_S.gguf");
    write("lmstudio/mradermacher/Hammer2.1-3b-GGUF/Hammer2.1-3b.Q8_0.gguf");
    write("lmstudio/mradermacher/Hammer2.1-3b-GGUF/Hammer2.1-3b.f16.gguf");
    // vision repo: the mmproj projector must be skipped, the real model kept
    write("lmstudio/bartowski/Vis-GGUF/mmproj-Vis-f16.gguf");
    write("lmstudio/bartowski/Vis-GGUF/Vis-Q8_0.gguf");
    // a complete sharded set: only the first shard is kept (llama.cpp auto-loads the rest)
    write("lmstudio/katanemo/Big.gguf/Big-F16-00001-of-00003.gguf");
    write("lmstudio/katanemo/Big.gguf/Big-F16-00002-of-00003.gguf");
    write("lmstudio/katanemo/Big.gguf/Big-F16-00003-of-00003.gguf");
    // a partial download: only shard 2 present (no first shard) → the whole model is unloadable, skip it
    write("lmstudio/publisher/Partial-GGUF/Partial-bf16-00002-of-00002.gguf");
    return { kind: "lmstudio", dir };
  }

  it("derives publisher/repo ids and skips mmproj + partial-shard models", () => {
    const models = discoverModels([seedLmStudio()], "dev");
    expect(new Set(models.map((m) => m.id))).toEqual(
      new Set(["katanemo/Arch-Agent-1.5B", "mradermacher/Hammer2.1-3b", "bartowski/Vis", "katanemo/Big"]),
    );
  });

  it("skips the mmproj projector but keeps the real model in the same repo", () => {
    const byId = idToBase(discoverModels([seedLmStudio()], "dev"));
    expect(byId["bartowski/Vis"]).toBe("Vis-Q8_0.gguf");
  });

  it("keeps only the FIRST shard of a sharded set", () => {
    const byId = idToBase(discoverModels([seedLmStudio()], "dev"));
    expect(byId["katanemo/Big"]).toBe("Big-F16-00001-of-00003.gguf");
  });

  it("collapses a multi-quant repo via the ladder (dev → q4, prod → f16)", () => {
    const src = seedLmStudio();
    expect(idToBase(discoverModels([src], "dev"))["mradermacher/Hammer2.1-3b"]).toBe("Hammer2.1-3b.Q4_K_S.gguf");
    expect(idToBase(discoverModels([src], "prod"))["mradermacher/Hammer2.1-3b"]).toBe("Hammer2.1-3b.f16.gguf");
  });

  it("resolves a discovered id (bare AND its lmstudio: namespaced form) to its path", () => {
    const src = seedLmStudio();
    const want = path.join(src.dir, "katanemo", "Arch-Agent-1.5B.gguf", "Arch-Agent-1.5B.gguf");
    expect(resolveModelPath("katanemo/Arch-Agent-1.5B", [src], "dev")).toBe(want);
    expect(resolveModelPath("lmstudio:katanemo/Arch-Agent-1.5B", [src], "dev")).toBe(want);
  });
});

describe("discoverModels — Ollama store", () => {
  /** Write an OCI image manifest at `manifests/registry.ollama.ai/<ns>/<model>/<tag>` referencing a model
   *  blob digest. When `withBlob`, also write the blob at `blobs/sha256-<hex>`. */
  function seedManifest(ns: string, model: string, tag: string, hex: string, size: number, withBlob: boolean): void {
    const manifest = {
      schemaVersion: 2,
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      config: { mediaType: "application/vnd.docker.container.image.v1+json", digest: "sha256:cfg", size: 4 },
      layers: [
        { mediaType: "application/vnd.ollama.image.template", digest: "sha256:tmpl", size: 3 },
        { mediaType: "application/vnd.ollama.image.model", digest: `sha256:${hex}`, size },
      ],
    };
    write(path.join("ollama/manifests/registry.ollama.ai", ns, model, tag), JSON.stringify(manifest));
    if (withBlob) write(path.join("ollama/blobs", `sha256-${hex}`), "g".repeat(Math.max(1, size)));
  }

  function ollamaSource(): Source {
    return { kind: "ollama", dir: path.join(root, "ollama") };
  }

  it("resolves a library manifest to its blob (model:tag id, layer size)", () => {
    seedManifest("library", "qwen2.5", "latest", "aaa111", 7, true);
    const models = discoverModels([ollamaSource()]);
    expect(models).toHaveLength(1);
    const m = models[0]!;
    expect(m.id).toBe("qwen2.5:latest");
    expect(m.path).toBe(path.join(root, "ollama", "blobs", "sha256-aaa111"));
    expect(m.sizeBytes).toBe(7);
    expect(m.source).toBe("ollama");
  });

  it("namespaces a non-library manifest as ns/model:tag", () => {
    seedManifest("myuser", "mymodel", "v1", "bbb222", 5, true);
    expect(discoverModels([ollamaSource()]).map((m) => m.id)).toContain("myuser/mymodel:v1");
  });

  it("skips a manifest whose model blob is missing", () => {
    seedManifest("library", "ghost", "latest", "ccc333", 9, false);
    seedManifest("library", "real", "latest", "ddd444", 9, true);
    expect(discoverModels([ollamaSource()]).map((m) => m.id)).toEqual(["real:latest"]);
  });

  it("yields nothing for a store with no manifests dir", () => {
    mkdirSync(path.join(root, "ollama-empty", "blobs"), { recursive: true });
    expect(discoverModels([{ kind: "ollama", dir: path.join(root, "ollama-empty") }])).toEqual([]);
  });
});

describe("discoverModels — arbitrary --models-dir tree", () => {
  it("collapses same-dir quant variants and cleans the id", () => {
    write("md/mymodel-q4_k_m.gguf");
    write("md/mymodel-q8_0.gguf");
    write("md/nested/Other-f16.gguf");
    const byId = idToBase(discoverModels([{ kind: "models-dir", dir: path.join(root, "md") }], "dev"));
    expect(byId["mymodel"]).toBe("mymodel-q4_k_m.gguf"); // dev picks q4
    expect(byId["Other"]).toBe("Other-f16.gguf");
  });
});

describe("discoverModels — precedence + collision namespacing", () => {
  // A bare `foo` produced by BOTH a roster source and an LM Studio store.
  function seedCollision(): { roster: Source; lmstudio: Source; rosterFoo: string; lmFoo: string } {
    const rosterFoo = write("roster/foo.gguf");
    const lmFoo = write("lm/foo.gguf"); // directly in the lmstudio root → primaryId "foo"
    return {
      roster: { kind: "roster", dir: path.join(root, "roster") },
      lmstudio: { kind: "lmstudio", dir: path.join(root, "lm") },
      rosterFoo,
      lmFoo,
    };
  }

  it("keeps the bare id on the roster (canonical) and namespaces the LM Studio collider", () => {
    const { roster, lmstudio } = seedCollision();
    const byId = new Map(discoverModels([roster, lmstudio], "dev").map((m) => [m.id, m.source]));
    expect(byId.get("foo")).toBe("roster");
    expect(byId.get("lmstudio:foo")).toBe("lmstudio");
    expect(byId.has("ollama:foo")).toBe(false);
  });

  it("resolves a bare colliding id to the highest-precedence source, namespaced to the exact one", () => {
    const { roster, lmstudio, rosterFoo, lmFoo } = seedCollision();
    expect(resolveModelPath("foo", [roster, lmstudio], "dev")).toBe(rosterFoo);
    expect(resolveModelPath("lmstudio:foo", [roster, lmstudio], "dev")).toBe(lmFoo);
  });

  it("advertises both the bare roster id and the namespaced collider in listModelIds", () => {
    const { roster, lmstudio } = seedCollision();
    const ids = listModelIds([roster, lmstudio], "dev");
    expect(ids).toContain("foo");
    expect(ids).toContain("lmstudio:foo");
  });

  it("keeps a non-colliding store id bare", () => {
    write("lm2/pub/Solo-GGUF/Solo-Q4_K_M.gguf");
    const ids = discoverModels([{ kind: "lmstudio", dir: path.join(root, "lm2") }], "dev").map((m) => m.id);
    expect(ids).toEqual(["pub/Solo"]);
  });
});
