/**
 * Label fitting for the connection sidebar.
 *
 * Long table names used to vanish. Each row's `<text>` had no width of its own,
 * so once `indent + glyph + label` exceeded the panel the text renderable was
 * measured as zero columns and drew *nothing* — not even a clipped prefix. Real
 * schemas are full of names like `ProviderRestrictedCountry`, so the row either
 * showed a name or showed a blank line, which read as a rendering glitch.
 *
 * The panel width is fixed, so the budget can be computed exactly and applied in
 * JS rather than left to the layout engine, which does not clip as configured.
 */

/** Panel width, shared so the label budget can never drift from the layout. */
export const SIDEBAR_WIDTH = 32
/** The 1-cell divider on the right edge. */
const DIVIDER = 1
/** `paddingX={1}` on each side of a row. */
const ROW_PADDING = 2
/**
 * One column that the row never fills. A label that exactly consumes the
 * remaining width leaves the text renderable measured at zero columns, and it
 * draws *nothing* — not even the ellipsis. `ProviderRestrictedCountry` is
 * exactly 25 characters, which is exactly the budget for a depth-2 table, so
 * the name that broke the sidebar was blank rather than clipped. Measured
 * against the real panel, the glyph-to-label gap is the first column lost, so
 * the budget keeps two back and the ellipsis always lands inside the panel.
 */
const SAFETY = 2

/**
 * Clip `label` to whatever is left of the row after `prefixWidth` (indent plus
 * glyphs), marking the cut with an ellipsis.
 */
export function fitLabel(label: string, prefixWidth: number, width: number = SIDEBAR_WIDTH): string {
  const budget = width - DIVIDER - ROW_PADDING - SAFETY - prefixWidth
  /* No room for a character at all: an empty string, not a negative slice. */
  if (budget <= 0) return ""
  /* One character plus the ellipsis. Below that the ellipsis is the honest
     answer — "…" still says "there is a name here". */
  if (budget < 2) return "…"
  if (label.length <= budget) return label
  return `${label.slice(0, budget - 1)}…`
}
