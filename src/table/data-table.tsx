/**
 * Data table view. Renders column headers plus a small window of rows around
 * the cursor (full virtualization), a cursor arrow, sort indicators, and an
 * in-place cell-edit preview.
 *
 * Horizontal layout is a `<scrollbox>`: when columns overflow the pane, the
 * view scrolls sideways (keyboard left/right pan via the active column, shift+
 * wheel via the terminal) and a thin horizontal scrollbar shows the position.
 * Vertical navigation stays keyboard-driven — the vim cursor slides the row
 * window, which is what keeps 1500-row pages cheap — so the grid scrolls on
 * both axes without ever rendering more rows than fit on screen.
 *
 * The active column is kept in view: only the focused row's cells carry ids
 * (`dient-col-<row>-<column>`), and after the cursor or column moves we ask
 * the scrollbox to reveal that cell (nearest-edge, no-op when already
 * visible). Selected rows read via bright text on the theme's lighter
 * `bgHighlight` band, which follows the terminal colorscheme.
 */
import { useEffect, useMemo, useRef } from "react"
import { useTheme } from "@/theme-context"
import type { ScrollBoxRenderable } from "@opentui/core"
import { formatCell, MAX_COL_WIDTH, MIN_COL_WIDTH, type UseTableResult } from "@/table/use-table"

export interface DataTableProps {
  readonly table: UseTableResult
  readonly viewportRows?: number
  readonly availableWidth?: number
  readonly editing?: { readonly column: string; readonly draft: string } | null
  readonly activeColumn?: string
  readonly highlight?: string
  readonly empty?: string
}

/** Trailing gap after every column so cells never butt against the next. */
export const COLUMN_GUTTER = 2

/**
 * Column widths for a frame: the content width from `useTable`, plus a fixed
 * gutter, plus a share of any *remaining* pane width so the grid fills the
 * terminal instead of ending at the widest value. Each column caps at
 * `MAX_COL_WIDTH`, like the content widths already do — the grid never grows
 * a column absurdly wide just because the terminal is.
 */
export const useColumnWidths = (
  columns: ReadonlyArray<{ readonly name: string }>,
  baseWidthOf: (column: string) => number,
  availableWidth?: number
): ((column: string) => number) =>
  useMemo(() => {
    const n = columns.length
    if (n === 0) return () => 0
    const base = columns.map(column => baseWidthOf(column.name))
    const fixed = base.reduce((sum, width) => sum + width, 0) + COLUMN_GUTTER * n
    const extra = Math.max(0, (availableWidth ?? fixed) - fixed)
    const per = Math.floor(extra / n)
    const rest = extra - per * n
    const widths: Record<string, number> = {}
    columns.forEach((column, index) => {
      const share = per + (index < rest ? 1 : 0)
      widths[column.name] = Math.min(base[index]! + share, MAX_COL_WIDTH) + COLUMN_GUTTER
    })
    return column => widths[column] ?? COLUMN_GUTTER
  }, [columns, baseWidthOf, availableWidth])

export function DataTable({
  table,
  viewportRows = 20,
  availableWidth,
  editing = null,
  activeColumn,
  highlight,
  empty,
}: DataTableProps) {
  const theme = useTheme()
  const c = theme.colors
  const { columns, cursor, sortedRows, sort } = table

  if (sortedRows.length === 0) {
    return (
      <box flexGrow={1} alignItems="center" justifyContent="center">
        <text fg={c.textMuted}>{empty ?? "no rows"}</text>
      </box>
    )
  }

  const widthOf = useColumnWidths(columns, table.widthOf, availableWidth)
  const window = rowsWindow(sortedRows, cursor, viewportRows)

  const scrollRef = useRef<ScrollBoxRenderable | null>(null)

  /* Keep the focused column in view as the cursor or the cell cursor moves.
     Only the focused row's cells carry ids, so there is exactly one target. */
  useEffect(() => {
    if (!activeColumn || !scrollRef.current) return
    scrollRef.current.scrollChildIntoView(`dient-col-${cursor}-${activeColumn}`)
  }, [activeColumn, cursor, columns, sortedRows.length])

  return (
    <scrollbox
      ref={scrollRef}
      scrollX
      scrollY={false}
      flexGrow={1}
      horizontalScrollbarOptions={{ showArrows: false }}
    >
      <box flexDirection="column">
        <HeaderRow columns={columns} sort={sort} widthOf={widthOf} />
        {window.rows.map((row, windowIndex) => {
          const rowIndex = window.offset + windowIndex
          const selected = rowIndex === cursor
          return (
            <RowLine
              key={rowIndex}
              row={row}
              columns={columns}
              selected={selected}
              widthOf={widthOf}
              editing={editing}
              activeColumn={activeColumn}
              rowIndex={rowIndex}
              highlight={highlight}
            />
          )
        })}
      </box>
    </scrollbox>
  )
}

interface RowsWindow {
  readonly offset: number
  readonly rows: ReadonlyArray<Record<string, unknown>>
}

export const rowsWindow = (
  rows: ReadonlyArray<Record<string, unknown>>,
  cursor: number,
  viewportRows: number
): RowsWindow => {
  const total = rows.length
  if (total === 0) return { offset: 0, rows: [] }
  const half = Math.floor(viewportRows / 2)
  const start = Math.max(0, Math.min(cursor - half, total - viewportRows))
  return {
    offset: start,
    rows: rows.slice(start, start + viewportRows),
  }
}

function HeaderRow({
  columns,
  sort,
  widthOf,
}: {
  columns: DataTableProps["table"]["columns"]
  sort: UseTableResult["sort"]
  widthOf: (column: string) => number
}) {
  const theme = useTheme()
  const c = theme.colors
  return (
    <box flexDirection="row" paddingX={1}>
      <text fg={c.textBright} width={1}>
        {" "}
      </text>
      {columns.map(column => {
        const marker = sort?.column === column.name ? (sort.dir === "asc" ? " ▲" : " ▼") : ""
        return (
          <box key={column.name} width={widthOf(column.name)} overflow="hidden">
            <text fg={c.textBright} truncate>
              {column.name.toUpperCase()}
              {marker}
            </text>
          </box>
        )
      })}
    </box>
  )
}

function RowLine({
  row,
  columns,
  selected,
  rowIndex,
  widthOf,
  editing,
  activeColumn,
  highlight,
}: {
  row: Record<string, unknown>
  columns: DataTableProps["table"]["columns"]
  selected: boolean
  rowIndex: number
  widthOf: (column: string) => number
  editing?: DataTableProps["editing"]
  activeColumn?: string
  highlight?: string
}) {
  const theme = useTheme()
  const c = theme.colors
  const matches = (formatted: string): boolean =>
    highlight !== undefined &&
    highlight.length > 0 &&
    formatted.toLowerCase().includes(highlight.toLowerCase())

  return (
    <box flexDirection="row" paddingX={1} backgroundColor={selected ? c.bgHighlight : undefined}>
      <text fg={selected ? c.accent : c.textMuted} width={1}>
        {selected ? "▶" : " "}
      </text>
      {columns.map(column => {
        const editingThis = editing && editing.column === column.name
        /* Only the focused row's cells carry scroll ids, unique per row, so
           `scrollChildIntoView` has exactly one child to reveal. */
        const cellId = selected && activeColumn === column.name ? `dient-col-${rowIndex}-${column.name}` : undefined
        const formatted = editingThis ? editing.draft : formatCell(row[column.name])
        const fg = selected ? c.textBright : editingThis ? c.success : c.text
        const parts =
          matches(formatted) && !editingThis ? splitHighlighted(formatted, highlight!) : null
        return (
          <box key={column.name} id={cellId} width={widthOf(column.name)}>
            {parts ? (
              <box flexDirection="row">
                {parts.map((part, index) => (
                  <text key={index} fg={part.matched ? c.accent : fg} truncate>
                    {part.text}
                  </text>
                ))}
              </box>
            ) : (
              <text fg={fg} truncate>
                {formatted}
              </text>
            )}
          </box>
        )
      })}
    </box>
  )
}

/** Split text around a case-insensitive needle so the match can be tinted. */
export const splitHighlighted = (
  text: string,
  needle: string
): ReadonlyArray<{ readonly text: string; readonly matched: boolean }> => {
  const parts: Array<{ text: string; matched: boolean }> = []
  let rest = text
  const lowerNeedle = needle.toLowerCase()
  while (rest.length > 0) {
    const lower = rest.toLowerCase()
    const index = lower.indexOf(lowerNeedle)
    if (index < 0) {
      parts.push({ text: rest, matched: false })
      return parts
    }
    if (index > 0) parts.push({ text: rest.slice(0, index), matched: false })
    parts.push({ text: rest.slice(index, index + needle.length), matched: true })
    rest = rest.slice(index + needle.length)
  }
  return parts
}

export { MAX_COL_WIDTH, MIN_COL_WIDTH }
