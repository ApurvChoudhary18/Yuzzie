/**
 * What text on a board may contain (SPEC.md §18 Session 16).
 *
 * Card titles, comments and names end up printed in other people's terminals.
 * A control character there is an instruction to that terminal — clear the
 * screen, move the cursor, retitle the window, fake a line of output — so none
 * is accepted, and whatever arrives anyway (older data, another client) is
 * shown as `�` rather than obeyed.
 *
 * One-line text (titles, names, labels) may contain no control character at
 * all. Multi-line text (descriptions, comments) may contain newlines and tabs.
 */

/** C0 controls, DEL, and C1 controls (U+0080–U+009F, which include an 8-bit CSI). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is this module's purpose
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is this module's purpose
const CONTROL_EXCEPT_NEWLINE_TAB = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is this module's purpose
const CONTROL_ALL = /[\u0000-\u001f\u007f-\u009f]/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is this module's purpose
const CONTROL_EXCEPT_NEWLINE_TAB_ALL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/** The first control character not allowed in `text`, or null. */
export function firstControlCharacter(text: string, multiline: boolean): string | null {
  const match = (multiline ? CONTROL_EXCEPT_NEWLINE_TAB : CONTROL).exec(text)
  return match === null ? null : match[0]
}

/** `U+001B` — how a refused character is named in an error message. */
export function codePoint(character: string): string {
  return `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
}

/** Text safe to print in a terminal: every control character becomes `�`. */
export function printable(text: string, options: { multiline?: boolean } = {}): string {
  return text.replace(
    options.multiline === true ? CONTROL_EXCEPT_NEWLINE_TAB_ALL : CONTROL_ALL,
    '�',
  )
}
