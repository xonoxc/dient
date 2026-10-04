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
  /** True when columns were dropped to fit — otherwise the truncation is silent. */
  readonly truncated: boolean
}

const LABEL_WIDTH = 22
const TYPE_WIDTH = 16

export function RowPreview({
  tableName,
  row,
  columns,
  primaryKey,
  position,
  total,
  maxRows,
  truncated,
}: RowPreviewProps) {
  const theme = useTheme()
  const c = theme.colors
  const key = primaryKey.map(name => formatCell(row[name])).join(", ")
  const shown = columns.slice(0, maxRows)
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
      <ModalSurface width={72} paddingY={1}>
        <box height={1} flexDirection="row">
          <text fg={c.textBright}>{tableName}</text>
          <text fg={c.textMuted}>
            {" "}
            · row {position} of {total}
            {key ? ` · pk ${key}` : ""}
          </text>
        </box>
        <box height={1} />
        {shown.map(column => (
          <box key={column.name} height={1} flexDirection="row">
            <text fg={c.accentMuted} width={LABEL_WIDTH}>
              {column.name}
            </text>
            {showTypes ? (
              <text fg={c.textMuted} width={TYPE_WIDTH}>
                {column.type ?? ""}
              </text>
            ) : null}
            <text fg={c.text}>{formatCell(row[column.name])}</text>
          </box>
        ))}
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
          <text fg={c.textMuted}> · j/k rows · Esc close </text>
        </box>
      </ModalSurface>
    </box>
  )
}
