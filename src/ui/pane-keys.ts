/**
 * Pane numbering. A screen with more than one focusable pane lists those panes
 * in layout order — left to right — and lets the number keys address them: `1`
 * is the leftmost pane, `2` the next, and so on. The same rule holds on every
 * screen, so the key never depends on the screen's own vocabulary.
 *
 * Only plain single digits count. A modified digit is a chord, and a shifted
 * digit (`!`, `@`, …) is not a pane number; `normalModeKey` turns the latter
 * back into the symbol the user actually typed.
 */
import { normalModeKey, type TypedKeyEvent } from "@/ui/text-entry"

/** The pane index a key addresses, or null when it is not a pane number. */
export const paneIndexForKey = (e: TypedKeyEvent, paneCount: number): number | null => {
  if (e.ctrl === true || e.meta === true || e.option === true || e.super === true) return null
  const key = normalModeKey(e)
  if (key.length !== 1 || key < "1" || key > "9") return null
  const index = Number(key) - 1
  return index < paneCount ? index : null
}
