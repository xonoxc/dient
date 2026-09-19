/**
 * Data table state. Keeps the raw row order, a sort key, and the cursor; the
 * renderer only ever sees a small window around the cursor (`windowedRows`),
 * so a 50k-row result stays cheap to draw. Column widths are derived from a
 * bounded sample so they never require mapping the whole dataset.
 */
import { useMemo, useState } from "react"
import type { ColumnInfo } from "@/drivers/types"

export interface SortState {
  readonly column: string
  readonly dir: "asc" | "desc"
}

export const MIN_COL_WIDTH = 8
export const MAX_COL_WIDTH = 28

export const formatCell = (value: unknown): string => {
  if (value === null || value === undefined) return "∅"
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "object") {
    if (value instanceof Date) return value.toISOString()
    if (value instanceof Uint8Array) return `<${value.length} bytes>`
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

export interface UseTableResult {
  readonly columns: ReadonlyArray<ColumnInfo>
  readonly cursor: number
  readonly sort: SortState | null
  readonly sortedRows: ReadonlyArray<Record<string, unknown>>
  readonly widths: Readonly<Record<string, number>>
  readonly widthOf: (column: string) => number
  readonly move: (delta: -1 | 1) => void
  readonly jump: (position: "first" | "last") => void
  readonly sortBy: (column: string) => void
}

export const useTable = (
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: ReadonlyArray<ColumnInfo>
): UseTableResult => {
  const [cursor, setCursor] = useState(0)
  const [sort, setSort] = useState<SortState | null>(null)

  const clamp = (next: number): number => Math.max(0, Math.min(rows.length - 1, next))

  const sortedRows = useMemo(() => {
    if (!sort) return rows
    const { column, dir } = sort
    const factor = dir === "asc" ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = a[column]
      const bv = b[column]
      if (av === null || av === undefined) return 1
      if (bv === null || bv === undefined) return -1
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * factor
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * factor
    })
  }, [rows, sort])

  /* Bounded sampling keeps width computation O(1) for huge tables. */
  const widths = useMemo(() => {
    const sample = sortedRows.slice(0, 100)
    const next: Record<string, number> = {}
    for (const column of columns) {
      let longest = column.name.length
      for (const row of sample) {
        const len = formatCell(row[column.name]).length
        if (len > longest) longest = len
      }
      next[column.name] = Math.max(1, Math.min(MAX_COL_WIDTH, longest))
    }
    return next
  }, [sortedRows, columns])

  return {
    columns,
    cursor,
    sort,
    sortedRows,
    widths,
    widthOf: column => widths[column] ?? MIN_COL_WIDTH,
    move: delta => setCursor(c => clamp(c + delta)),
    jump: position => setCursor(position === "first" ? 0 : Math.max(0, rows.length - 1)),
    sortBy: column => {
      setSort(current => {
        if (!current || current.column !== column) return { column, dir: "asc" }
        if (current.dir === "asc") return { column, dir: "desc" }
        return null
      })
    },
  }
}

