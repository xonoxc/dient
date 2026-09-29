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
 * `bgHighlight` band, which follows the terminal colorscheme. The visual-mode
 * span reuses that same band, so a selection reads as the cursor widened.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { useTheme } from "@/theme-context"
import { HorizontalScrollIndicator } from "@/table/horizontal-scroll-indicator"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { SelectionRange } from "@/vim/types"
import { formatCell, MAX_COL_WIDTH, MIN_COL_WIDTH, type UseTableResult } from "@/table/use-table"

export interface DataTableProps {
  readonly table: UseTableResult
  readonly viewportRows?: number
  readonly availableWidth?: number
  readonly editing?: { readonly column: string; readonly draft: string } | null
  readonly activeColumn?: string
  readonly columnFocus?: boolean
  readonly highlight?: string
  /** Visual-mode row span (inclusive). Rows in it wear the cursor's band; the
      cursor row itself keeps the `▶` marker so the head stays findable. */
  readonly selection?: SelectionRange | null
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
  columnFocus = false,
  highlight,
  selection = null,
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
  const tableWidth = Math.max(0, 2 + columns.reduce((total, column) => total + widthOf(column.name), 0))

  const scrollRef = useRef<ScrollBoxRenderable | null>(null)

  /* Keep the focused column in view as the cursor or the cell cursor moves.
     Only the focused row's cells carry ids, so there is exactly one target. */
  useEffect(() => {
    if (!activeColumn || !scrollRef.current) return
    scrollRef.current.scrollChildIntoView(`dient-col-${cursor}-${activeColumn}`)
  }, [activeColumn, cursor, columns, sortedRows.length])

  return (
    <box flexGrow={1} flexDirection="column">
      <scrollbox
        ref={scrollRef}
        scrollX
        scrollY={false}
        flexGrow={1}
        /* OpenTUI's own bar is switched off rather than restyled. Its slider
         hard-codes the thumb glyph (`█`, with `▌`/`▐` half-cells at the ends)
         and fills the entire track with a background, so it always occupies a
         full row and always looks like a solid bar sitting on top of the
         status bar. A row is the finest unit a character cell has, so the only
         way to get something thinner is to draw it ourselves. */
        horizontalScrollbarOptions={{ visible: false }}
      >
        <box flexDirection="column">
          <HeaderRow columns={columns} sort={sort} widthOf={widthOf} tableWidth={tableWidth} activeColumn={columnFocus ? activeColumn : undefined} />
          {window.rows.map((row, windowIndex) => {
            const rowIndex = window.offset + windowIndex
            const selected = rowIndex === cursor
            const inSelection = selection !== null && rowIndex >= selection.start && rowIndex <= selection.end
            return (
              <RowLine
                key={rowIndex}
                row={row}
                columns={columns}
                selected={selected}
                inSelection={inSelection}
                widthOf={widthOf}
                editing={editing}
                activeColumn={activeColumn}
                columnFocus={columnFocus}
                rowIndex={rowIndex}
                highlight={highlight}
                tableWidth={tableWidth}
              />
            )
          })}
        </box>
      </scrollbox>
      <HorizontalScrollIndicator box={scrollRef.current} />
    </box>
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
  tableWidth,
  activeColumn,
}: {
  columns: DataTableProps["table"]["columns"]
  sort: UseTableResult["sort"]
  widthOf: (column: string) => number
  tableWidth: number
  activeColumn?: string
}) {
  const theme = useTheme()
  const c = theme.colors
  return (
    <box width={tableWidth} flexDirection="row" paddingLeft={1} backgroundColor={c.bgSurface}>
      <text fg={c.text} width={1}>
        {" "}
      </text>
      {columns.map((column, index) => {
        const marker = sort?.column === column.name ? (sort.dir === "asc" ? " ▲" : " ▼") : ""
        const last = index === columns.length - 1
        return (
          <box key={column.name} width={widthOf(column.name) - (last ? 1 : 0)} flexDirection="row" overflow="hidden">
            <text fg={activeColumn === column.name ? c.textBright : c.accent} width={Math.max(1, widthOf(column.name) - 2)} truncate>
              {column.name.toUpperCase()}{marker}
            </text>
            <text fg={c.grid}>{last ? "│" : "│ "}</text>
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
  inSelection,
  rowIndex,
  widthOf,
  tableWidth,
  editing,
  activeColumn,
  columnFocus,
  highlight,
}: {
  row: Record<string, unknown>
  columns: DataTableProps["table"]["columns"]
  selected: boolean
  inSelection: boolean
  rowIndex: number
  widthOf: (column: string) => number
  tableWidth: number
  editing?: DataTableProps["editing"]
  activeColumn?: string
  columnFocus: boolean
  highlight?: string
}) {
  const theme = useTheme()
  const c = theme.colors
  const matches = (formatted: string): boolean =>
    highlight !== undefined && highlight.length > 0 && formatted.toLowerCase().includes(highlight.toLowerCase())
  /* The cursor row and the selected rows share the band; the cursor is the one
     that reads as "where the head is", so it alone gets the arrow. */
  const banded = selected || inSelection

  return (
    <box width={tableWidth} flexDirection="row" paddingLeft={1} backgroundColor={banded ? c.bgHighlight : undefined}>
      <text fg={selected ? c.accent : c.textMuted} width={1}>
        {selected ? "▶" : " "}
      </text>
      {columns.map((column, index) => {
        const editingThis = editing && editing.column === column.name
        const activeCell = selected && columnFocus && activeColumn === column.name
        /* Only the focused row's cells carry scroll ids, unique per row, so
           `scrollChildIntoView` has exactly one child to reveal. */
        const cellId = selected && activeColumn === column.name ? `dient-col-${rowIndex}-${column.name}` : undefined
        const formatted = editingThis ? editing.draft : formatCell(row[column.name])
        const fg = banded ? c.textBright : editingThis ? c.success : c.text
        const parts = matches(formatted) && !editingThis ? splitHighlighted(formatted, highlight!) : null
        const last = index === columns.length - 1
        return (
          <box key={column.name} id={cellId} width={widthOf(column.name) - (last ? 1 : 0)} flexDirection="row" overflow="hidden" backgroundColor={activeCell ? c.bgSurface : undefined}>
            <box width={Math.max(1, widthOf(column.name) - 2)} overflow="hidden">
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
            <text fg={c.grid}>{last ? "│" : "│ "}</text>
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
