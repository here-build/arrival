// Font stacks — the writing/reading split (rationale in fonts.css).

/** The WRITING font stack — the editor surface, under the caret. */
export const FONT_WRITING = `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace`;
/** The READING stacks — rendered overlay text the user never edits.
 *  Argon (humanist) carries VALUES, Krypton (mechanical) carries TYPES. */
export const FONT_READING_VALUES = `"Monaspace Argon", ${FONT_WRITING}`;
export const FONT_READING_TYPES = `"Monaspace Krypton", ${FONT_WRITING}`;
