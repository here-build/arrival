// SRFI-128 — comparators. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack (via `allSrfi`) and evals it
// (via initBridge's assembleEnv), so this module is the sole definition site.
//
// MIGRATED off the text-blob `prelude` (docs/working-proposals/symbol-define-static-
// program-validation.md, wave W4/H2b): each SRFI-128 verb is now an individually-
// declared `symbol.define`, contract-enforced from day one (§1.2 rev2 ruling) — no
// more opaque prelude string, no more assembly-order-luck cross-capability
// references (§2.1's bake FV locality law forces every free name into either this
// capability's OWN symbol set or a DECLARED `deps` edge).
//
// THE SAME LUCK CLASS srfi-235 (W4/H1) and srfi-43 (W4/H2) found — here BOTH
// flavors at once (design doc §2.1's "live catch", §4.1's census): every body below
// calls `pair?`/`eq?`/`null?`/`boolean?`/`string?`/`symbol?`/`symbol->string`/
// `equal?`/`not` (scheme/equality), `number?`/`=`/`<` (scheme/numeric), `char?`/
// `char<?` (scheme/chars), `string<?` (scheme/strings) — all FOUR are NATIVE_PACKS
// members (srfi-43's luck class: already bound on `global_env` by the two-phase
// bootstrap, so a standalone `.apply()` with deps unwalked still resolves them) —
// AND `list` (scheme/lists) — a BASE_PACKS member (srfi-235's luck class: genuinely
// absent without walking `deps`, since `lists` only assembles onto `user_env` in
// phase 2). None of the five was declared pre-migration; the bake FV law
// (`define-bake.ts`) refuses every one of them as an undeclared free reference, so
// each gets the same fix: a real `deps` edge below. `car`/`cdr`/`cadr`/`caddr`/
// `cadddr` need NO edge — the resolver-synth `c[ad]+r` family (`define-bake.ts`'s
// `CXR_RE`) is recognized directly, unconditionally, regardless of luck class.
// `deps: [equality, numeric, chars, strings, lists]` is the complete,
// empirically-verified set — `pnpm test` is the proof (see
// `__tests__/srfi-128-symbol-define.test.ts`). No repositioning of
// `base-packs.ts`'s array is needed: `equality`/`numeric`/`chars`/`strings` are
// NATIVE_PACKS members (never entries of the BASE_PACKS array C3 linearizes over —
// srfi-43's own header names the same fact for its three); `lists` IS a BASE_PACKS
// member but was already repositioned last by srfi-235's migration (W4/H1) for
// exactly this reason — unchanged by this note.
//
// Contract choices (§1.2's "REAL contract authored per define, day one"):
//   - `comparator` is modeled precisely, not as opaque `z.value`: SRFI-128's own
//     representation here is `(list 'comparator type-test equality ordering)` — a
//     FIXED 4-element proper list (tag symbol + 3 procedures) — so `comparatorSchema
//     = z.list([z.symbol, z.lambda, z.lambda, z.lambda])` is the honest structural
//     contract, catching a malformed/foreign comparator at the call boundary instead
//     of an opaque `cadr`-on-wrong-shape crash deep inside an accessor body.
//   - `comparator?` is the one exception: a type PREDICATE must accept arbitrary
//     values (that is its entire job) — `{ input: [z.value], output: [z.boolean] }`,
//     mirroring r7rs/equality.ts's own `null?`/`boolean?` convention. Using the
//     strict `comparatorSchema` here would make `(comparator? 5)` THROW instead of
//     answering `#f` — the opposite of a predicate's contract.
//   - `comparator-hashable?` is not merely `z.boolean` but the literal
//     `z.booleanFalse`: arrival has no value-hash (unchanged from the pre-migration
//     header note), so this SRFI-128 slot always answers `#f` — the tightest honest
//     contract available.
//   - the private `%`-prefixed helpers (`%chain-rel`, `%type-rank`, `%default-less`)
//     get real per-define contracts too (§4.2 Pass 1 is "one symbol.define per
//     value/procedure define", not "per public API member"). `%chain-rel`'s `rest`
//     is `z.list()` (a proper, possibly-empty list of arbitrary values — walked via
//     `car`/`cdr`/`null?`, never indexed), not the shapeless shortcut.
//   - `=?`/`<?`/`>?`/`<=?`/`>=?` share the `c a b . rest` shape: fixed
//     `[comparatorSchema, z.value, z.value]` + `inputRest: z.value` (the chain can
//     hold arbitrarily many further elements of any type — the comparator's own
//     predicates judge them, not this contract) + `output: [z.boolean]`.
//   - `%type-rank` returns one of the literal exact integers 0..7 — `z.exact`, not
//     the looser `z.number`/`z.integer` union (mirrors srfi-43's own precedent for
//     "these are always exact literal counts").
import { EnvCapability } from "../../common/capability.js";
import { symbol } from "../../common/symbol.js";
import * as z from "../../common/scheme-zod.js";
import equality from "../r7rs/equality.js";
import numeric from "../r7rs/numeric.js";
import chars from "../r7rs/chars.js";
import strings from "../r7rs/strings.js";
import lists from "../r7rs/lists.js";

// The SRFI-128 comparator's own representation: `(list 'comparator type-test
// equality ordering)` — see the file header's contract-choices note.
const comparatorSchema = z.list([z.symbol, z.lambda, z.lambda, z.lambda]);

export default new EnvCapability("scheme/srfi-128", {
  deps: [equality, numeric, chars, strings, lists],
  symbols: {
    "make-comparator":
      symbol.define`make-comparator: bundle (type-test equality ordering) into a comparator — a 4th hash arg is accepted for SRFI-128 source-compat but IGNORED (arrival has no value-hash)`(
        { input: [z.lambda, z.lambda, z.lambda], inputRest: z.value, output: [comparatorSchema] },
        `(lambda (type-test equality ordering . hash)
           (list 'comparator type-test equality ordering))`,
      ),

    "comparator?": symbol.define`comparator?: #t iff obj is a comparator built by make-comparator`(
      { input: [z.value], output: [z.boolean] },
      `(lambda (x) (and (pair? x) (eq? (car x) 'comparator)))`,
    ),

    "comparator-type-test-predicate":
      symbol.define`comparator-type-test-predicate: the type-test procedure c was built with`(
        { input: [comparatorSchema], output: [z.lambda] },
        `(lambda (c) (cadr c))`,
      ),

    "comparator-equality-predicate":
      symbol.define`comparator-equality-predicate: the equality procedure c was built with`(
        { input: [comparatorSchema], output: [z.lambda] },
        `(lambda (c) (caddr c))`,
      ),

    "comparator-ordering-predicate":
      symbol.define`comparator-ordering-predicate: the ordering (less-than) procedure c was built with`(
        { input: [comparatorSchema], output: [z.lambda] },
        `(lambda (c) (cadddr c))`,
      ),

    "comparator-hashable?":
      symbol.define`comparator-hashable?: always #f — arrival has no value-hash, so the hash slot is decorative`(
        { input: [comparatorSchema], output: [z.booleanFalse] },
        `(lambda (c) #f)`,
      ),

    "%chain-rel":
      symbol.define`%chain-rel: rel holds for every adjacent pair in (a b . rest) — the shared chain-comparison engine behind =?/<?/>?/<=?/>=?`(
        { input: [z.lambda, z.value, z.value, z.list()], output: [z.boolean] },
        `(lambda (rel a b rest)
           (if (rel a b)
               (if (null? rest) #t (%chain-rel rel b (car rest) (cdr rest)))
               #f))`,
      ),

    "=?": symbol.define`=?: c's equality predicate holds for every adjacent pair in (a b . rest)`(
      { input: [comparatorSchema, z.value, z.value], inputRest: z.value, output: [z.boolean] },
      `(lambda (c a b . rest) (%chain-rel (comparator-equality-predicate c) a b rest))`,
    ),

    "<?": symbol.define`<?: c's ordering predicate holds for every adjacent pair in (a b . rest)`(
      { input: [comparatorSchema, z.value, z.value], inputRest: z.value, output: [z.boolean] },
      `(lambda (c a b . rest) (%chain-rel (comparator-ordering-predicate c) a b rest))`,
    ),

    ">?": symbol.define`>?: c's ordering predicate holds, reversed, for every adjacent pair in (a b . rest)`(
      { input: [comparatorSchema, z.value, z.value], inputRest: z.value, output: [z.boolean] },
      `(lambda (c a b . rest)
         (let ((lt (comparator-ordering-predicate c))) (%chain-rel (lambda (x y) (lt y x)) a b rest)))`,
    ),

    "<=?":
      symbol.define`<=?: c's ordering predicate never holds in reverse for every adjacent pair in (a b . rest)`(
        { input: [comparatorSchema, z.value, z.value], inputRest: z.value, output: [z.boolean] },
        `(lambda (c a b . rest)
           (let ((lt (comparator-ordering-predicate c))) (%chain-rel (lambda (x y) (not (lt y x))) a b rest)))`,
      ),

    ">=?":
      symbol.define`>=?: c's ordering predicate never holds forward for every adjacent pair in (a b . rest)`(
        { input: [comparatorSchema, z.value, z.value], inputRest: z.value, output: [z.boolean] },
        `(lambda (c a b . rest)
           (let ((lt (comparator-ordering-predicate c))) (%chain-rel (lambda (x y) (not (lt x y))) a b rest)))`,
      ),

    "%type-rank":
      symbol.define`%type-rank: a type's position in the default total order (boolean < number < char < string < symbol < null < pair < other)`(
        { input: [z.value], output: [z.exact] },
        `(lambda (x)
           (cond ((boolean? x) 0) ((number? x) 1) ((char? x) 2) ((string? x) 3)
                 ((symbol? x) 4) ((null? x) 5) ((pair? x) 6) (else 7)))`,
      ),

    "%default-less":
      symbol.define`%default-less: the default-comparator's total order — by type rank, then the native within-type order`(
        { input: [z.value, z.value], output: [z.boolean] },
        `(lambda (a b)
           (let ((ra (%type-rank a)) (rb (%type-rank b)))
             (if (not (= ra rb)) (< ra rb)
                 (cond ((number? a) (< a b))
                       ((char? a) (char<? a b))
                       ((string? a) (string<? a b))
                       ((symbol? a) (string<? (symbol->string a) (symbol->string b)))
                       ((boolean? a) (and (not a) b))
                       (else #f)))))`,
      ),

    "make-default-comparator":
      symbol.define`make-default-comparator: a comparator over the total order %default-less imposes across all types`(
        { input: [], output: [comparatorSchema] },
        `(lambda () (make-comparator (lambda (x) #t) equal? %default-less))`,
      ),

    "default-comparator": symbol.define`default-comparator: the shared instance of make-default-comparator`(
      { input: [], output: [comparatorSchema] },
      `(lambda () (make-default-comparator))`,
    ),
  },
});
