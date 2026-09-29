/**
 * Single-line input windowing.
 *
 * Every text surface renders `value + ▍` in a flex row. OpenTUI does not
 * scroll a text node and its `truncate` keeps the *head*, so once the value is
 * longer than the row the newest characters — and the cursor, which always
 * sits at the end because editing is append-only — fall off the right edge.
 * Pasting a connection string therefore hides exactly the part the user is
 * looking at.
 *
 * `windowTail` keeps the tail instead, so the edit point stays visible. It
 * cannot measure the row itself (OpenTUI exposes no reliable flex measurement
 * in the React layer), so each caller passes the budget it knows from its own
 * fixed widths and terminal dimensions.
 */

/** The tail of `text` that fits in `budget` cells; never wider than `budget`. */
export const windowTail = (text: string, budget: number): string => {
  const room = Math.max(0, Math.floor(budget))
  return text.length <= room ? text : text.slice(text.length - room)
}
