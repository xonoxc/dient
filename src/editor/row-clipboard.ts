/**
 * Row yank for table rows. A yank covers the visual selection's span, or the
 * cursor row alone when no selection is open (the state machine's default, so
 * the helper stays honest even though the table only binds `y` in visual mode).
 * The text is the row editor's `column: value` pairs with the comment header
 * dropped, so what lands on the clipboard is data a user can paste back, not the
 * instructions the editor file carries.
 *
 * The row set is the table's own window (the current page, filtered and sorted
 * as displayed), because that is what the selection indexes: a yank can never
 * reach rows the user cannot see.
 */
import { Option } from "effect"
import type { TableColumn } from "@/inspector/types"
import { serializeRowsToClipboard } from "@/editor/row-serialization"
import { selectionRange } from "@/vim/vim"
import type { Selection } from "@/vim/types"

export interface RowYank {
  /** Clipboard text: key/value pairs, one row per blank-line-separated block. */
  readonly text: string
  /** How many rows the yank covered, for the confirmation message. */
  readonly count: number
}

/** The rows a yank covers, normalized so a reversed selection still yanks forwards.
    A selection is clamped to the loaded window; a bare cursor outside it covers
    nothing, because there is no row under the cursor to copy. */
export const rowsForYank = (
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  cursor: number,
  selection: Option.Option<Selection>
): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  if (Option.isNone(selection)) {
    if (cursor < 0) return []
    return rows.slice(cursor, cursor + 1)
  }
  const picked = selectionRange(selection.value)
  const start = Math.max(0, Math.min(picked.start, rows.length - 1))
  const end = Math.max(start, Math.min(picked.end, rows.length - 1))
  return rows.slice(start, end + 1)
}

/** Build the clipboard text for a yank, or null when there is nothing to copy. */
export const yankRows = (
  columns: ReadonlyArray<TableColumn>,
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  cursor: number,
  selection: Option.Option<Selection>
): RowYank | null => {
  if (columns.length === 0 || rows.length === 0) return null
  const picked = rowsForYank(rows, cursor, selection)
  if (picked.length === 0) return null
  return { text: serializeRowsToClipboard(columns, picked), count: picked.length }
}
