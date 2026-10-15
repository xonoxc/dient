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

export const MIN_COL_WIDTH = 4
export const MAX_COL_WIDTH = 28

/** Maximum number of lines a cell can take for display. Longer content is truncated */
export const MAX_CELL_LINES = 1

/**
 * The width one column needs: the longest of its cell texts, floored at
 * `MIN_COL_WIDTH`. Shared with the clipboard serializer so a copied table is
 * padded to the measure the grid draws with — one definition of "how wide is
 * this column", rather than a second one that drifts.
 */
export const columnWidth = (header: string, cells: Iterable<string>): number => {
  let longest = header.length
  for (const cell of cells) if (cell.length > longest) longest = cell.length
  return Math.max(MIN_COL_WIDTH, longest)
}

/** `columnWidth` per column, in schema order. */
export const columnWidths = (
  columns: ReadonlyArray<ColumnInfo>,
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>
): ReadonlyArray<number> =>
  columns.map(column =>
    columnWidth(
      column.name,
      rows.map(row => formatCell(row[column.name]))
    )
  )

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

/**
 * Truncate text to fit within a budget while preserving tail (end) of the text.
 * Used for display truncation: keeps the most recent characters visible.
 * Appends "…" when truncated.
 */
export const truncateForDisplay = (text: string, budget: number): string => {
  const room = Math.max(0, Math.floor(budget))
  if (text.length <= room) return text
  // Leave room for ellipsis
  if (room <= 1) return ""
  const usable = room - 1
  return text.slice(-usable) + "…"
}

/**
 * Limit cell content to a maximum number of lines by truncating long values.
 * Also truncates each line to fit within the column width.
 */
export const formatCellDisplay = (value: unknown, maxWidth: number): string => {
  const formatted = formatCell(value)

  // Check if content spans multiple lines
  const lines = formatted.split("\n")

  if (lines.length <= MAX_CELL_LINES) {
    // Single line - just truncate if needed
    return truncateForDisplay(formatted, maxWidth)
  }

  // Multiple lines - truncate to first N lines and truncate each line
  return lines
    .slice(0, MAX_CELL_LINES)
    .map(line => truncateForDisplay(line, maxWidth))
    .join("\n")
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

  /* Bounded sampling keeps width computation O(1) for huge tables. Widths are
     floored at MIN_COL_WIDTH (4): OpenTUI's flex layout collapses boxes
     narrower than that, which would break column alignment. */
  const widths = useMemo(() => {
    const sample = sortedRows.slice(0, 100)
    const next: Record<string, number> = {}
    /* Only the display clamps to MAX_COL_WIDTH: a column wider than the
       viewport is clipped on screen, but a clipboard payload that clipped its
       own values would be data loss rather than a layout decision. */
    columnWidths(columns, sample).forEach((width, index) => {
      const name = columns[index]!.name
      next[name] = Math.min(MAX_COL_WIDTH, width)
    })
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
