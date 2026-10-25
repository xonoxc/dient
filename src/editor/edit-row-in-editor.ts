/**
 * `$EDITOR`-based row editing. The cursor row is serialized to a temp file of
 * `column: value` lines (generated from the table schema) and handed to the
 * user's editor (`$EDITOR`/`$VISUAL`, falling back to `vi`), spawned inline in
 * the terminal. While the editor owns the terminal the renderer is suspended
 * (raw mode off, alternate screen released), then resumed on exit; the edited
 * file is parsed back and offered to the caller as typed UPDATE parameters.
 *
 * This replaces an in-TUI form: the user gets their own editor (vim, nano,
 * code) with full syntax, and Escape/save semantics are whatever that editor
 * provides — nothing is lost by a stray keypress inside the app.
 */
import type { TableColumn } from "@/inspector/types"
import type { RowValueUpdate } from "@/editor/row-serialization"
import { parseRowKeyValue, serializeRowToKeyValue } from "@/editor/row-serialization"
import { editorCommand, runEditorSession, type EditorCallbacks, type EditorRenderer } from "@/editor/editor-session"

export type { EditorRenderer }
export { editorCommand }

export interface EditRowCallbacks extends EditorCallbacks {
  /** Called with the parsed changes once the editor committed a valid file. */
  readonly onChanges: (updates: ReadonlyArray<RowValueUpdate>) => void
}

export interface EditRowOptions {
  readonly renderer: EditorRenderer
  readonly tableName: string
  readonly columns: ReadonlyArray<TableColumn>
  readonly primaryKey: ReadonlyArray<string>
  readonly row: Readonly<Record<string, unknown>>
  readonly callbacks: EditRowCallbacks
}

/** Launch `$EDITOR` over a temp `column: value` file of the row and report parsed changes. */
export const editRowInEditor = (options: EditRowOptions): void => {
  const { renderer, tableName, columns, primaryKey, row, callbacks } = options

  runEditorSession({
    renderer,
    label: tableName,
    filename: tableName,
    content: serializeRowToKeyValue(columns, row),
    callbacks,
    onSave: edited => {
      const result = parseRowKeyValue(edited, columns, primaryKey, row)
      if (!result.ok) {
        callbacks.error(result.error)
        return
      }
      if (result.updates.length === 0) {
        callbacks.notice("no changes to save")
        return
      }
      callbacks.onChanges(result.updates)
    },
  })
}
