/**
 * Inline cell editor. While a cell is being edited the screen routes printable
 * keys here; `commit` validates against the column type before handing the
 * value to the caller (which persists it and reloads the page).
 *
 * The target/draft/error are kept in refs so that a single batched keypress
 * burst (e.g. key Repeat through the mock terminal) can open the editor, type,
 * and commit against synchronous state. A version bump triggers the next app
 * render so the DataTable preview and the status bar reflect the live draft.
 */
import { useRef, useState } from "react"
import type { ColumnInfo } from "@/drivers/types"

export interface CellEditTarget {
  readonly rowIndex: number
  readonly column: string
  readonly original: string
}

export interface UseCellEditorResult {
  /** Live accessor: true while a cell edit is in flight (ref-backed, safe to
      read between batched keypresses). */
  readonly isEditing: () => boolean
  /** Live accessor for the current edit target. */
  readonly editTarget: () => CellEditTarget | null
  /** Live accessor for the last validation error. */
  readonly errorValue: () => string | null
  /** Render snapshot for the DataTable preview (recomputed every frame). */
  readonly preview: { readonly column: string; readonly draft: string } | null
  readonly open: (target: CellEditTarget) => void
  readonly type: (character: string) => void
  readonly backspace: () => void
  readonly clear: () => void
  readonly commit: (columns: ReadonlyArray<ColumnInfo>) => { readonly value: string } | null
  readonly cancel: () => void
}

const NUMERIC = /^-?\d+(\.\d+)?$/

export const validateCellValue = (column: ColumnInfo, value: string): string | null => {
  const type = (column.type ?? "").toLowerCase()
  if (!type) return null
  if (value === "") return null
  if (/int|bigint|smallint|numeric|decimal|real|float|double|serial|money|double_precision/.test(type)) {
    if (!NUMERIC.test(value)) return `"${column.name}" expects a number`
  }
  if (/bool/.test(type)) {
    if (!/^(true|false|0|1)$/i.test(value)) return `"${column.name}" expects true/false`
  }
  return null
}

export const useCellEditor = (): UseCellEditorResult => {
  const targetRef = useRef<CellEditTarget | null>(null)
  const draftRef = useRef("")
  const errorRef = useRef<string | null>(null)
  const [, bump] = useState(0)
  const render = (): void => bump(version => version + 1)

  return {
    isEditing: () => targetRef.current !== null,
    editTarget: () => targetRef.current,
    errorValue: () => errorRef.current,
    preview: targetRef.current ? { column: targetRef.current.column, draft: draftRef.current } : null,
    open: next => {
      targetRef.current = next
      draftRef.current = next.original
      errorRef.current = null
      render()
    },
    type: character => {
      if (character.length !== 1) return
      errorRef.current = null
      draftRef.current = draftRef.current + character
      render()
    },
    backspace: () => {
      draftRef.current = draftRef.current.slice(0, -1)
      render()
    },
    clear: () => {
      targetRef.current = null
      draftRef.current = ""
      errorRef.current = null
      render()
    },
    commit: columns => {
      const target = targetRef.current
      if (!target) return null
      const column = columns.find(candidate => candidate.name === target.column)
      if (column) {
        const validation = validateCellValue(column, draftRef.current)
        if (validation) {
          errorRef.current = validation
          render()
          return null
        }
      }
      return { value: draftRef.current }
    },
    cancel: () => {
      targetRef.current = null
      draftRef.current = ""
      errorRef.current = null
      render()
    },
  }
}
