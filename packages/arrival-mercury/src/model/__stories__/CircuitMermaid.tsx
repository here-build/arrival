/**
 * CircuitMermaid — renders a mermaid flowchart SOURCE STRING (as produced by
 * `circuitToMermaid`) into an SVG, via the `mermaid` library's own render API
 * (never mermaid's DOM auto-scan — `preview.ts` sets `startOnLoad: false`, so
 * this component owns exactly when a render happens).
 *
 * Lives under `__stories__/` (not `src/model/`) so it never ships in the
 * package's published `dist`/`files` surface (package.json's `files` array
 * excludes `!**\/__stories__`) — this is a gallery fixture, not library code.
 *
 * A malformed diagram (a real risk: this gallery exists precisely to catch a
 * circuit-mermaid.ts regression before it reaches a reviewer) must not crash
 * the whole story file — one bad render shows its error text and the other
 * stories keep rendering.
 */
import { useEffect, useId, useRef, useState } from "react";
import mermaid from "mermaid";

export interface CircuitMermaidProps {
  readonly mermaid: string;
}

export function CircuitMermaid({ mermaid: source }: CircuitMermaidProps) {
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    mermaid
      .render(`circuit-${reactId}`, source)
      .then(({ svg }) => {
        if (!cancelled && containerRef.current) containerRef.current.innerHTML = svg;
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [source, reactId]);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", color: "#c9d1d9", background: "#12161f", padding: 16 }}>
      <div ref={containerRef} />
      {error !== null && (
        <pre style={{ color: "#e5484d", whiteSpace: "pre-wrap" }}>Mermaid render error: {error}</pre>
      )}
      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer", color: "#8b93a7" }}>mermaid source</summary>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{source}</pre>
      </details>
    </div>
  );
}
