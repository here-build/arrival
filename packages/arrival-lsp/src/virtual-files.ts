// virtual-files — the file-name constants of the lens compilation's virtual fs.
//
// Split out of `prelude.ts` so the environment-agnostic service core (and the
// browser entry) can name the program/prelude files without pulling `node:fs`
// into their module graph. `prelude.ts` re-exports both for back-compat.

/** The virtual file name of the shared PRE prelude inside the lens file map. */
export const PRELUDE_FILE = "__pre.d.ts";

/** The virtual file name of the emitted program module inside the lens file map. */
export const PROGRAM_FILE = "__program.ts";
