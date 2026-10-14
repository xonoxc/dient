/**
 * Row preview overlay — what `Enter` opens on a row.
 *
 * Enter is an *inspection* key, not an edit key: it shows the whole row as
 * `column: value` pairs with nothing wrapped around the terminal and nothing
 * committed. Editing is one keystroke further in (`i`), which keeps the two
 * intents from colliding — a stray Enter while moving through a table can never
 * leave a half-typed value behind, because there is no field to half-type into.
 *
 * The pairing is also what the `$EDITOR` file itself looks like, so the preview
 * teaches the format the edit is about to hand over.
 *
 * The explorer owns the keyboard and the open/closed flag; this is the pure
 * view, like `FinderOverlay`.
 */
import { useTheme } from "@/theme-context"
import { formatCell } from "@/table/use-table"
import { ModalSurface } from "@/ui/modal-surface"

export interface RowPreviewProps {
  readonly tableName: string
  readonly row: Record<string, unknown>
  /** Schema order. The type is shown but not trusted: the grid's columns come
      from the query result, where the type is optional. */
  readonly columns: ReadonlyArray<{ readonly name: string; readonly type?: string }>
  /** Primary key columns, so the reader can tell which row they are looking at. */
  readonly primaryKey: ReadonlyArray<string>
  /** Row `n` of `total`, so a wide table reads as "one of many", not "the only one". */
  readonly position: number
  readonly total: number
  /** Rows the panel may spend on values: everything else is the terminal's. */
  readonly maxRows: number
  readonly activeColumn: string | undefined
  /** Responsive panel dimensions, leaving a small margin around the terminal. */
  readonly width: number
  readonly maxHeight: number
  /** True when columns were dropped to fit — otherwise the truncation is silent. */
  readonly truncated: boolean
}

const TYPE_WIDTH = 16

const wrapValue = (value: string, width: number): ReadonlyArray<string> => {
  const room = Math.max(1, width)
  const lines: string[] = []
  for (const paragraph of value.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("")
      continue
    }
    for (let at = 0; at < paragraph.length; at += room) {
      lines.push(paragraph.slice(at, at + room))
    }
  }
  return lines.length > 0 ? lines : [""]
}

export function RowPreview({
  tableName,
  row,
  columns,
  primaryKey,
  position,
  total,
  maxRows,
  activeColumn,
  width,
  maxHeight,
  truncated,
}: RowPreviewProps) {
  const theme = useTheme()
  const c = theme.colors
  const key = primaryKey.map(name => formatCell(row[name])).join(", ")
  const shown = columns.slice(0, maxRows)
  const labelWidth = Math.min(24, Math.max(8, ...shown.map(column => column.name.length + 2)))
  /* Engines that report no per-column type would otherwise leave a sixteen
     column hole in front of every value. */
  const showTypes = columns.some(column => column.type)

  return (
    <box
      position="absolute"
      width="100%"
      height="100%"
      alignItems="center"
      justifyContent="center"
      backgroundColor={c.bg}
    >
      <ModalSurface width={width} paddingY={1} maxHeight={maxHeight}>
        <box height={1} flexDirection="row">
          <text fg={c.textBright}>{tableName}</text>
          <text fg={c.textMuted}>
            {" "}
            · row {position} of {total}
            {key ? ` · pk ${key}` : ""}
          </text>
        </box>
        <box height={1} />
        {shown.map(column => {
          const valueWidth = Math.max(1, width - labelWidth - (showTypes ? TYPE_WIDTH : 0) - 8)
          const lines = wrapValue(formatCell(row[column.name]), valueWidth)
          const selected = column.name === activeColumn
          return lines.map((line, index) => (
            <box key={`${column.name}-${index}`} height={1} flexDirection="row">
              {index === 0 ? (
                <text fg={selected ? c.accent : c.accentMuted} width={labelWidth}>
                  {selected ? "› " : "  "}{column.name}:
                </text>
              ) : <text width={labelWidth}> </text>}
              {showTypes ? (
                <text fg={c.textMuted} width={TYPE_WIDTH}>
                  {index === 0 ? column.type ?? "" : ""}
                </text>
              ) : null}
              <text fg={selected ? c.textBright : c.text} truncate={false}>{line || " "}</text>
            </box>
          ))
        })}
        {truncated ? (
          <>
            <box height={1} />
            <text fg={c.textMuted}>…{columns.length - shown.length} more columns (not shown)</text>
          </>
        ) : null}
        <box height={1} />
        <box height={1} flexDirection="row">
          <text fg={c.textMuted}> i edit </text>
          <text fg={c.success}>$EDITOR</text>
          <text fg={c.textMuted}> · h/l field · e expand · j/k row · Esc close </text>
        </box>
      </ModalSurface>
    </box>
  )
}
