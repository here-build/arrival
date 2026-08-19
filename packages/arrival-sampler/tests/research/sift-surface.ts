// sift-surface.ts — sift's MCP tool surface, reconstructed as a Σ registry for the Rnj experiment.
//
// sift exposes ~110 forensic tools, NAMESPACED BY SUBJECT (`process/pslist`, `socket/netscan`,
// `ip/external-c2-candidate?`, …) — a very different vocabulary from the flat apple-intent verbs:
// `/`-separated subject/verb names, `?` predicates, bare entity constructors (`ip`, `dt`, `path`).
// The canonical definitions live in `sift-submission/mcp/src/{discovery-env,packs,entities}.ts`
// (`createDiscoveryEnv` + `toolCatalog`). The oracle masks against bound NAMES + callability, so to
// measure "how does Rnj's distribution sit on sift's surface" we only need the names bound — we
// reconstruct them here as data (no dependency on the sift package, no heavy env assembly), exactly as
// `apple-intents/sim.ts` binds the apple registry. Names + arities mirror sift's published roster.

import { LexicalScope, EnvCapability, type SessionScope, type SymbolDeclaration } from "@inhuman.tools/arrival";
import type { OracleEnvΣ } from "@inhuman.tools/arrival/oracle";

import { grantFromCapability } from "../../src/runners/fixtures/apple-intents/sim.js";

/** One sift tool: scheme-callable `subject/verb` name, an args hint (for the prompt), arity, one-liner. */
export interface SiftTool {
  readonly name: string;
  readonly args: string;
  readonly arity: number;
  readonly doc: string;
}

const t = (name: string, args: string, arity: number, doc: string): SiftTool => ({ name, args, arity, doc });

/** The reconstructed sift surface, grouped by forensic subject (evidence subjects then reference). */
export const SIFT_SURFACE: Record<string, readonly SiftTool[]> = {
  // ── EVIDENCE subjects (read frozen evidence) ──
  process: [
    t("process/pslist", "(process/pslist)", 0, "Active process list (PID, PPID, ImageFileName, times)."),
    t("process/psscan", "(process/psscan)", 0, "Pool-scanned processes (finds hidden/exited)."),
    t("process/pstree", "(process/pstree)", 0, "Process tree."),
    t("process/cmdline", "(process/cmdline)", 0, "Per-process command lines."),
    t("process/dlllist", "(process/dlllist 1234)", 1, "Loaded DLLs for a PID."),
    t("process/getsids", "(process/getsids 1234)", 1, "SID tokens for a PID."),
  ],
  socket: [t("socket/netscan", "(socket/netscan)", 0, "Network connections (proto, addrs, ports, PID, owner).")],
  region: [
    t("region/malfind", "(region/malfind 1234)", 1, "RWX / injected memory regions for a PID."),
    t(
      "region/malfind/jit-host?",
      '(region/malfind/jit-host? "chrome.exe")',
      1,
      "Is this a JIT host (RWX false positive)?",
    ),
    t(
      "region/malfind/pe-injected?",
      "(region/malfind/pe-injected? row)",
      1,
      "Does the region carry an injected PE header?",
    ),
    t("region/yara-scan-memory", '(region/yara-scan-memory 1234 "Meterpreter")', 2, "YARA scan a PID's memory."),
  ],
  service: [t("service/svcscan", "(service/svcscan)", 0, "Windows services (name, state, start, binary).")],
  file: [
    t("file/filescan", "(file/filescan)", 0, "Cached file objects in memory."),
    t("file/dumpfiles", "(file/dumpfiles 1234)", 1, "Extract file bytes for a PID."),
    t("file/mft", String.raw`(file/mft "C:\\Windows\\Temp")`, 1, "Parse $MFT (optional path filter)."),
    t("file/mmls", "(file/mmls)", 0, "Partition table of a disk image."),
    t("file/fls", String.raw`(file/fls "C:\\Windows\\Temp")`, 1, "File listing incl. deleted (optional path)."),
    t("file/istat", "(file/istat 12345)", 1, "Inode metadata."),
    t("file/fcat", "(file/fcat 12345)", 1, "Content summary (sha256, magic) of an inode/path."),
    t("file/hashes", String.raw`(file/hashes "C:\\Windows")`, 1, "Hash list under a path."),
  ],
  registry: [
    t("registry/registry", '(registry/registry "Run")', 1, "Key/value query (optional key filter)."),
    t("registry/run-keys", "(registry/run-keys)", 0, "Autorun persistence (Run/RunOnce)."),
    t("registry/amcache", "(registry/amcache)", 0, "Amcache.hve program evidence."),
    t("registry/shimcache", '(registry/shimcache ".exe")', 1, "AppCompatCache (optional path filter)."),
  ],
  execution: [
    t("execution/prefetch", '(execution/prefetch "cmd")', 1, "Windows Prefetch (optional name filter)."),
    t("execution/shimcache", '(execution/shimcache ".exe")', 1, "AppCompatCache execution evidence."),
    t("execution/userassist", '(execution/userassist "chrome")', 1, "GUI launch evidence."),
    t("execution/bam", '(execution/bam ".exe")', 1, "BAM/DAM last-execution times."),
    t("execution/srum", '(execution/srum "chrome.exe")', 1, "SRUM per-app network usage."),
    t("execution/amcache", "(execution/amcache)", 0, "Amcache execution evidence."),
  ],
  event: [t("event/event-logs", "(event/event-logs 4624)", 1, "Event logs (optional EventId / filter).")],
  ioc: [
    t("ioc/yara-scan", String.raw`(ioc/yara-scan "C:\\Temp")`, 1, "YARA scan files (optional target)."),
    t("ioc/yara-scan-memory", '(ioc/yara-scan-memory 1234 "rule")', 2, "YARA scan a PID's memory."),
    t("ioc/ioc-match", "(ioc/ioc-match)", 0, "Match loaded IOCs against the evidence."),
    t("ioc/check-hash", '(ioc/check-hash "abc123…")', 1, "Hash reputation verdict."),
  ],
  timeline: [
    t("timeline/timeline", '(timeline/timeline "powershell")', 1, "Super-timeline (optional message filter)."),
    t(
      "timeline/timeline-range",
      '(timeline/timeline-range "2020-09-19T03:00:00Z" "2020-09-19T04:00:00Z")',
      2,
      "Events in a time window.",
    ),
    t("timeline/timeline-grep", '(timeline/timeline-grep "coreupdater")', 1, "Search timeline messages."),
  ],
  // ── REFERENCE subjects (pure reasoning vocabulary, always present) ──
  search: [
    t("search/sigma", '(search/sigma "lateral movement")', 1, "Search Sigma rules."),
    t("search/mitre", '(search/mitre "T1055")', 1, "Search MITRE ATT&CK."),
    t("search/atomic", '(search/atomic "process injection")', 1, "Search Atomic Red Team tests."),
  ],
  ip: [
    t("ip", '(ip "10.0.0.1")', 1, "Parse/refang an IP."),
    t("ip/v4?", "(ip/v4? e)", 1, "Is IPv4?"),
    t("ip/v6?", "(ip/v6? e)", 1, "Is IPv6?"),
    t("ip/global?", "(ip/global? e)", 1, "Is IANA-global?"),
    t("ip/private?", "(ip/private? e)", 1, "Is RFC1918 private?"),
    t("ip/loopback?", "(ip/loopback? e)", 1, "Is loopback?"),
    t("ip/multicast?", "(ip/multicast? e)", 1, "Is multicast?"),
    t("ip/external-c2-candidate?", "(ip/external-c2-candidate? e)", 1, "Plausible external C2 address?"),
    t("ip/show", "(ip/show e)", 1, "Canonical string."),
    t("ip/=", "(ip/= a b)", 2, "IP equality."),
    t("ip/extract", '(ip/extract "…text…")', 1, "Extract IPs from text."),
  ],
  dt: [
    t("dt", '(dt "2020-09-19T03:00:00Z")', 1, "Parse a timestamp (UTC)."),
    t("dt/before?", "(dt/before? a b)", 2, "Chronological before?"),
    t("dt/after?", "(dt/after? a b)", 2, "Chronological after?"),
    t("dt/within?", "(dt/within? t start end)", 3, "Within a window?"),
    t("dt/=", "(dt/= a b)", 2, "Equality."),
    t("dt/show", "(dt/show e)", 1, "ISO-8601 UTC string."),
  ],
  account: [
    t("account", String.raw`(account "CORP\\alice")`, 1, "Parse an account."),
    t("account/=", "(account/= a b)", 2, "Equality."),
    t("account/show", "(account/show e)", 1, "Canonical string."),
    t("account/extract", '(account/extract "…")', 1, "Extract accounts from text."),
    t("account/domain", "(account/domain e)", 1, "Domain part."),
    t("account/name", "(account/name e)", 1, "Name part."),
    t("account/machine?", "(account/machine? e)", 1, "Is a machine account?"),
    t("account/well-known?", "(account/well-known? e)", 1, "Is a well-known account?"),
    t("account/system?", "(account/system? e)", 1, "Is SYSTEM?"),
  ],
  sid: [
    t("sid", '(sid "S-1-5-18")', 1, "Parse a SID."),
    t("sid/=", "(sid/= a b)", 2, "Equality."),
    t("sid/show", "(sid/show e)", 1, "Canonical string."),
    t("sid/well-known?", "(sid/well-known? e)", 1, "Is a well-known SID?"),
    t("sid/system?", "(sid/system? e)", 1, "Is the SYSTEM SID?"),
    t("sid/admin?", "(sid/admin? e)", 1, "Is an admin SID?"),
    t("sid/machine-account?", "(sid/machine-account? e)", 1, "Is a machine-account SID?"),
    t("sid/rid", "(sid/rid e)", 1, "Relative identifier."),
  ],
  hash: [
    t("hash", '(hash "abc123…")', 1, "Parse a file hash (auto-detect algo)."),
    t("hash/=", "(hash/= a b)", 2, "Equality."),
    t("hash/show", "(hash/show e)", 1, "Canonical string."),
    t("hash/algo", "(hash/algo e)", 1, "Algorithm (md5/sha1/sha256)."),
    t("hash/sha256?", "(hash/sha256? e)", 1, "Is sha256?"),
  ],
  path: [
    t("path", String.raw`(path "C:\\Windows\\Temp\\x.exe")`, 1, "Parse a file path."),
    t("path/=", "(path/= a b)", 2, "Equality."),
    t("path/show", "(path/show e)", 1, "Canonical string."),
    t("path/basename", "(path/basename e)", 1, "Final component."),
    t("path/dirname", "(path/dirname e)", 1, "Directory part."),
    t("path/ext", "(path/ext e)", 1, "Extension."),
    t("path/windows?", "(path/windows? e)", 1, "Is a Windows path?"),
    t("path/ads?", "(path/ads? e)", 1, "Has an alternate data stream?"),
    t("path/system-dir?", "(path/system-dir? e)", 1, "Under a system directory?"),
    t("path/temp?", "(path/temp? e)", 1, "Under a temp directory?"),
    t("path/under?", "(path/under? e base)", 2, "Under a base path?"),
  ],
  domain: [
    t("domain", '(domain "evil.example.com")', 1, "Parse a domain (IDNA)."),
    t("domain/=", "(domain/= a b)", 2, "Equality."),
    t("domain/show", "(domain/show e)", 1, "Canonical string."),
    t("domain/tld", "(domain/tld e)", 1, "Top-level domain."),
    t("domain/registrable", "(domain/registrable e)", 1, "Registrable domain."),
    t("domain/subdomain?", "(domain/subdomain? e)", 1, "Is a subdomain?"),
  ],
  regkey: [
    t("regkey", String.raw`(regkey "HKLM\\…\\Run")`, 1, "Parse a registry key."),
    t("regkey/=", "(regkey/= a b)", 2, "Equality."),
    t("regkey/show", "(regkey/show e)", 1, "Canonical string."),
    t("regkey/hive", "(regkey/hive e)", 1, "Hive."),
    t("regkey/autorun?", "(regkey/autorun? e)", 1, "Is an autorun key?"),
    t("regkey/under?", "(regkey/under? e base)", 2, "Under a base key?"),
  ],
};

/** Every sift tool, flat. */
export const SIFT_TOOLS: readonly SiftTool[] = Object.values(SIFT_SURFACE).flat();

/** Stage-C grant surface a sift env resolves through (mirrors `apple-intents/sim.ts`'s
 *  `DeviceSim` shape: capabilities + scope + pre-built Σ grant). */
export interface SiftEnv {
  readonly capabilities: readonly EnvCapability[];
  readonly scope: SessionScope;
  readonly grant: OracleEnvΣ;
}

/** A grant surface with every sift tool bound as a recording no-op rosetta (the Σ surface the oracle
 *  masks against — calling a tool records and returns a plausible value, never doing anything real).
 *  Mirrors `apple-intents/sim.ts`. Test-local `EnvCapability` (`symbol.rosetta` verbs). */
export async function makeSiftEnv(): Promise<SiftEnv> {
  const scope = LexicalScope.fresh("sift-discovery");
  const cap = EnvCapability.define("sift-discovery", {
    symbols: (symbol, z) => {
      // Stage A2 (arrival core): `symbol.rosetta` mints the ARosettaProcedure directly
      // now, not a plain `RosettaSymbolDef` record — `SymbolDeclaration` is the record's
      // real element type either way.
      const symbols: Record<string, SymbolDeclaration> = {};
      for (const tool of SIFT_TOOLS) {
        symbols[tool.name] = symbol.rosetta`${tool.name}: sift no-op recording stub`(
          { input: [], inputRest: z.dynamic, output: [z.dynamic] },
          (): any => "ok",
        );
      }
      return symbols;
    },
  });
  return { capabilities: [cap], scope, grant: grantFromCapability(cap) };
}

/** The system prompt: sift's forensic surface, grouped by subject (mirrors `toolCatalog`'s shape). */
export function buildSiftPrompt(): string {
  const subjects = Object.entries(SIFT_SURFACE)
    .map(([subject, tools]) => [`## ${subject}`, ...tools.map((tl) => `- ${tl.args} — ${tl.doc}`)].join("\n"))
    .join("\n\n");
  return [
    "You are a Windows forensic analyst querying frozen evidence by emitting ONE Scheme program.",
    "Call ONLY the tools listed below, by their exact `subject/verb` names. The LAST form is the result.",
    "Bind intermediate results with (define …); filter rows with (filter …); read a row field with the",
    "keyword accessor, e.g. (:PID row). Strings in double-quotes, numbers bare, booleans #t/#f.",
    "",
    "TOOLS:",
    subjects,
    "",
    "EXAMPLES:",
    "User: List the running processes.\nProgram: (process/pslist)",
    'User: Is 10.0.0.5 an external C2 candidate?\nProgram: (ip/external-c2-candidate? (ip "10.0.0.5"))',
    "User: Show injected memory regions in PID 1234.\nProgram: (region/malfind 1234)",
  ].join("\n");
}

/** Forensic NL tasks exercising sift's surface (the scout's canonical use cases). */
export const SIFT_TASKS: readonly { id: string; prompt: string }[] = [
  { id: "pslist", prompt: "List the running processes." },
  { id: "netscan", prompt: "Show the current network connections." },
  { id: "malfind-pid", prompt: "Find injected RWX memory regions in process 1234." },
  { id: "cmdline-system", prompt: "Show the command lines of all processes." },
  { id: "getsids-pid", prompt: "What SIDs does process 1234 hold?" },
  { id: "svcscan", prompt: "List the Windows services and their binaries." },
  { id: "run-keys", prompt: "Show the autorun persistence registry entries." },
  { id: "prefetch", prompt: "What executables were run, from Prefetch?" },
  { id: "yara-mem", prompt: "Scan process 1234's memory for the Meterpreter signature." },
  { id: "check-hash", prompt: "Check the reputation of hash abc123def456." },
  { id: "external-c2", prompt: "Is the address 185.220.101.5 an external C2 candidate?" },
  { id: "timeline-window", prompt: "Show timeline events between 2020-09-19T03:00:00Z and 2020-09-19T04:00:00Z." },
  { id: "fls-temp", prompt: String.raw`List files, including deleted ones, under C:\Windows\Temp.` },
  {
    id: "autorun-key",
    prompt: String.raw`Is the registry key HKLM\Software\Microsoft\Windows\CurrentVersion\Run an autorun key?`,
  },
];
