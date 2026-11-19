/**
 * `$EDITOR`-based row editing: serialize the cursor row to a temp file of
 * `column: value` lines, run the editor inline, and parse the result back.
 */
import type { TableColumn } from "@/inspector/types"
import type { RowValueUpdate } from "@/editor/row-serialization"
import { parseRowKeyValue, serializeRowToKeyValue } from "@/editor/row-serialization"
import { editorCommand, runEditorSession, type EditorCallbacks, type EditorRenderer } from "@/editor/editor-session"

export type { EditorRenderer }
export { editorCommand }

export interface EditRowCallbacks extends EditorCallbacks {
  /** Called with parsed changes after a valid file is committed. */
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
