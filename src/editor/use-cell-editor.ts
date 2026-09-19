/**
 * Inline cell editor. While Vim mode is INSERT the screen routes printable
 * keys here; `commit` validates against the column type before handing the
 * value to the caller (which persists it and reloads the page).
 */
import { useState } from "react"
import type { ColumnInfo } from "@/drivers/types"

export interface CellEditTarget {
  readonly rowIndex: number
  readonly column: string
  readonly original: string
}

export interface UseCellEditorResult {
  readonly target: CellEditTarget | null
  readonly draft: string
  readonly error: string | null
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
  const [target, setTarget] = useState<CellEditTarget | null>(null)
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)

  return {
    target,
    draft,
    error,
    preview: target ? { column: target.column, draft } : null,
    open: next => {
      setTarget(next)
      setDraft(next.original)
      setError(null)
    },
    type: character => {
      if (character.length !== 1) return
      setError(null)
      setDraft(current => current + character)
    },
    backspace: () => setDraft(current => current.slice(0, -1)),
    clear: () => {
      setTarget(null)
      setDraft("")
      setError(null)
    },
    commit: columns => {
      if (!target) return null
      if (error) return null
      const column = columns.find(c => c.name === target.column)
      if (!column) return { value: draft }
      const validation = validateCellValue(column, draft)
      if (validation) {
        setError(validation)
        return null
      }
      return { value: draft }
    },
    cancel: () => {
      setTarget(null)
      setDraft("")
      setError(null)
    },
  }
}