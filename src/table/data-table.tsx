/**
 * Data table view. Renders column headers plus a small window of rows around
 * the cursor (full virtualization), alternating row tint, a selection accent,
 * sort indicators, and an in-place cell-edit preview.
 */
import { useTheme } from "@/theme-context"
import { formatCell, MAX_COL_WIDTH, MIN_COL_WIDTH, type UseTableResult } from "@/table/use-table"

export interface DataTableProps {
  readonly table: UseTableResult
  readonly viewportRows?: number
  readonly editing?: { readonly column: string; readonly draft: string } | null
  readonly empty?: string
}

export function DataTable({ table, viewportRows = 20, editing = null, empty }: DataTableProps) {
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

  const window = rowsWindow(sortedRows, cursor, viewportRows)

  return (
    <box flexGrow={1} flexDirection="column">
      <HeaderRow columns={columns} sort={sort} widthOf={table.widthOf} />
      {window.rows.map((row, windowIndex) => {
        const rowIndex = window.offset + windowIndex
        const selected = rowIndex === cursor
        return (
          <RowLine
            key={rowIndex}
            row={row}
            columns={columns}
            rowIndex={rowIndex}
            selected={selected}
            widthOf={table.widthOf}
            editing={editing}
          />
        )
      })}
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
}: {
  columns: DataTableProps["table"]["columns"]
  sort: UseTableResult["sort"]
  widthOf: (column: string) => number
}) {
  const theme = useTheme()
  const c = theme.colors
  return (
    <box flexDirection="row" paddingX={1} backgroundColor={c.bgSurface}>
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
  rowIndex,
  selected,
  widthOf,
  editing,
}: {
  row: Record<string, unknown>
  columns: DataTableProps["table"]["columns"]
  rowIndex: number
  selected: boolean
  widthOf: (column: string) => number
  editing?: DataTableProps["editing"]
}) {
  const theme = useTheme()
  const c = theme.colors
  const tinted = rowIndex % 2 === 1

  return (
    <box flexDirection="row" paddingX={1} backgroundColor={tinted ? c.bgSurface : undefined}>
      <text fg={selected ? c.accent : c.textMuted} width={1}>
        {selected ? "▶" : " "}
      </text>
      {columns.map(column => {
        const editingThis = editing && editing.column === column.name
        const formatted = editingThis ? editing.draft : formatCell(row[column.name])
        const fg = selected ? c.textBright : editingThis ? c.success : c.text
        return (
          <box key={column.name} width={widthOf(column.name)} overflow="hidden">
            <text fg={fg} bg={selected ? c.selection : undefined} truncate>
              {formatted}
            </text>
          </box>
        )
      })}
    </box>
  )
}

export { MAX_COL_WIDTH, MIN_COL_WIDTH }