# R7RS-small Completeness Audit

> **As of:** 2026-07-13 / commit `17ebb36564` + follow-on (numeric S2, always, this refresh)  
> **Policy:** Every R7RS-small export is **implemented** or a `symbol.notImplemented` door. Silent absence is a bug. Exceptions stay implemented. Continuations / multi-return / dynamics may be doors.  
> **Immutable subset:** mutators and multi-return are doors with teaching reasons — we do not aim to make the full mutable R7RS work.  
> **Aside:** `define-record-type` / record SRFIs are **out of scope** here (separate workstream).  
> **Inventory source:** [`docs/reference/r7rs-symbol-map.md`](./reference/r7rs-symbol-map.md)

---

## Executive summary (refreshed)

| Bucket | Health |
|---|---|
| Multi-return surface (`values`, `call-with-values`, `let-values`, `let*-values`, `define-values`) | **Doors** (`r7rs/binding`) |
| Host multi-product (`floor/`, `truncate/`) | **Impl as pair product** `(q . r)` — no `Values.from` |
| call/cc, delay, parameters | **Doors** (`r7rs/control`) |
| Exceptions §6.11 | **Fully impl** |
| Mutators | **Doors** on type packs + `set!` |
| Host §6.13 / §6.14 | **Totalized doors** (`r7rs/host` `DOORS` map, ~60 names incl. `features`) |
| Numeric S2 (`square`, `exact-integer-sqrt`, `rationalize`) | **Impl** (`exact-integer-sqrt` → pair product) |
| Still silent | structure / eval / library forms (below) |

---

## Focus clusters — current status

### §6.10 / multi-return / dynamics — done

| Symbol | Status |
|---|---|
| `apply`, `map`, `for-each`, string/vector map/for-each | **impl** |
| `call/cc`, `call-with-current-continuation`, `dynamic-wind` | **door** |
| `values`, `call-with-values`, `let-values`, `let*-values`, `define-values` | **door** |
| `delay` / `force` / `make-promise` / `delay-force` / `promise?` | **door** |
| `make-parameter` / `parameterize` | **door** |
| `set!` | **door** |

### §6.11 Exceptions — done (keep live)

`raise`, `raise-continuable`, `with-exception-handler`, `error`, `guard`, error-object surface — **impl**.

### §6.13 / §6.14 Host — done (doors)

Full port/IO/file/system surface doored in `r7rs/host.ts` (single `DOORS` inventory).  
Adjacent: `call-with-input-string` in `srfi-stubs` (SRFI-6).

---

## Remaining silent absences (actionable)

**Out of scope this pass:** `define-record-type` (records / separate SRFI).

### Structure / arity

| Symbol | § | Suggested |
|---|---|---|
| `case-lambda` | 4.2.9 | door or impl |

### Eval / environment reification

| Symbol | § | Note |
|---|---|---|
| `eval`, `load` | 6.12 / 6.14 | sandbox-unification pins **unbound**; policy wants **door** — retarget test |
| `environment`, `null-environment`, `scheme-report-environment`, `interaction-environment` | 6.12 | door with reification reason |

### Library / inclusion

| Symbol | § |
|---|---|
| `include` / `include-ci` | 4.1.7 / 5.6.1 |
| `cond-expand` | 4.2.1 / 5.6.1 |
| `define-library`, `import` | 5.6.1 / 5.2 |
| `syntax-error` | 4.3.3 |

### Residue (not silent)

`Values` / `z.values` types still in tree with no producer — optional delete later.

---

## Recommended next atoms

1. Door `case-lambda` (or implement).  
2. Door eval/load/env + retarget `sandbox-unification.test.ts`.  
3. Door library forms (`include`, `cond-expand`, `import`, …).  
4. Leave records aside.

---

## Method notes

- Multi-return **names** and **host minting** are extinguished for the agent-facing surface.  
- Chibi exclusions for multi-return / ports remain valid as “design omit”; numeric S2 names should no longer be “not implemented” exclusions (cascade rows may still mention `let*-values`).
