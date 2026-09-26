/**
 * Text-entry helpers shared by every field in the app (the `:` command line,
 * the finder query, `/` search, the cell editor, and every settings form).
 *
 * One rule holds all of them together: a screen that accepts text must be
 * able to type the text. Keybindings belong to NORMAL mode, which is only
 * active when nothing is being typed — so a field consumes *every* printable
 * key as a character, including `u`, `e`, `?` and `:`. A connection string is
 * made almost entirely of characters some other screen wanted as a binding
 * (`u` cycling the engine, `e` opening the explorer, `?` opening help), so
 * hijacking a letter inside a field silently corrupts what the user pastes.
 *
 * Shifted characters are the second trap. Terminals disagree about how to
 * report them: the kitty keyboard protocol sends the *unshifted* base key plus
 * a `shift` flag (`@` arrives as `2`), while a legacy terminal sends the
 * shifted byte but reports letters in lower case (`A` arrives as `a`). The
 * parser therefore hands us a `name` that is not the character the user
 * typed, and typing `key.length === 1` straight through writes `2` where the
 * user meant `@`. Reconstructing the character from `name` + `shift` makes
 * both protocols produce the same string.
 */

/** Keys a text field must never treat as a character to insert. */
const COMMAND_KEYS: ReadonlySet<string> = new Set([
  "return",
  "enter",
  "\r",
  "escape",
  "Escape",
  "\u001b",
  "tab",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "insert",
])

/**
 * US-layout shifted symbols, keyed by the unshifted key a terminal reports in
 * kitty mode. Only the US mapping is encoded because that is what the base
 * key code means; a terminal that reports the already-shifted character
 * (`@` rather than `2`) needs no mapping, which is why `resolveTypedChar`
 * leaves those alone.
 */
const SHIFTED_SYMBOLS: Readonly<Record<string, string>> = {
  "`": "~",
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
  "-": "_",
  "=": "+",
  "[": "{",
  "]": "}",
  "\\": "|",
  ";": ":",
  "'": '"',
  ",": "<",
  ".": ">",
  "/": "?",
}

/** The subset of a key event this module reads. */
export interface TypedKeyEvent {
  readonly name: string
  readonly shift?: boolean
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly option?: boolean
  readonly super?: boolean
}

/** Escape/Hyper/Super are reserved for chords and never insert a character. */
const hasCommandModifier = (e: TypedKeyEvent): boolean =>
  e.meta === true || e.option === true || e.super === true || e.ctrl === true

/**
 * The character a key event should insert into a text field, or `null` when
 * the key is a command (Enter, Escape, Tab, an arrow) or a modifier chord that
 * a field should leave to its own bindings.
 */
export const resolveTypedChar = (e: TypedKeyEvent): string | null => {
  if (COMMAND_KEYS.has(e.name)) return null
  if (hasCommandModifier(e)) return null
  if (e.name === "space") return " "
  if (e.name.length !== 1) return null
  if (e.shift !== true) return e.name
  /* Kitty mode reports the unshifted base key; legacy mode reports the letter
     in lower case. Both are recovered by applying the shift to `name`. */
  const symbol = SHIFTED_SYMBOLS[e.name]
  if (symbol !== undefined) return symbol
  const upper = e.name.toUpperCase()
  return upper === e.name ? e.name : upper
}

/** Whether a key event should act as a command rather than be typed. */
export const isCommandKey = (e: TypedKeyEvent): boolean => resolveTypedChar(e) === null
