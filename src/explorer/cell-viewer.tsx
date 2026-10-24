/**
 * Full-value cell viewer — what `e` opens on the active cell.
 *
 * The grid and the row preview both truncate long values to a fixed width, so
 * a 160-character name is only ever a hint that there is more. This panel
 * shows the whole value, hard-wrapped to the modal width and scrolled with
 * `j`/`k` when it runs past the visible rows. Pure view, like `RowPreview`:
 * the explorer owns the open flag, the scroll offset, and the keyboard. A
 * translucent scrim dims the table behind the elevated card.
 */
import { useTheme } from "@/theme-context"
import { ModalSurface } from "@/ui/modal-surface"

export interface CellViewerProps {
  readonly tableName: string
  readonly columnName: string
  readonly columnType?: string
  /** 1-based row position, so the viewer reads as "this cell", not "a string". */
  readonly position: number
  readonly total: number
  /** The complete formatted value — never display-truncated. */
  readonly value: string
  /** How many wrapped rows the panel may spend on the value. */
  readonly visibleRows: number
  /** First wrapped row on screen; the explorer clamps it. */
  readonly offset: number
}

/** Modal width, shared with the row preview so the two panels match. */
export const CELL_VIEWER_WIDTH = 72

/**
 * Text width inside the modal: the surface adds one column of shadow padding
 * around a `width`-wide panel, then `paddingX={2}` on each side.
 */
export const CELL_VIEWER_TEXT_WIDTH = CELL_VIEWER_WIDTH - 4

/**
 * Hard-wrap `text` to `width`-cell rows, preserving explicit newlines. A dumb
 * character split, not word wrap: values are identifiers, URIs, and JSON, so
 * breaking mid-word is correct and keeps the function total over any input.
 */
export const wrapText = (text: string, width: number): ReadonlyArray<string> => {
  const room = Math.max(1, Math.floor(width))
  const rows: string[] = []
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      rows.push("")
      continue
    }
    for (let at = 0; at < paragraph.length; at += room) rows.push(paragraph.slice(at, at + room))
  }
  return rows
}

export function CellViewer({
  tableName,
  columnName,
  columnType,
  position,
  total,
  value,
  visibleRows,
  offset,
}: CellViewerProps) {
  const theme = useTheme()
  const c = theme.colors
  const lines = wrapText(value, CELL_VIEWER_TEXT_WIDTH)
  const room = Math.max(1, visibleRows)
  const top = Math.max(0, Math.min(offset, Math.max(0, lines.length - room)))
  const shown = lines.slice(top, top + room)
  const scrollable = lines.length > room

  return (
    <box position="absolute" top={0} bottom={0} left={0} right={0} alignItems="center" justifyContent="center">
      <box position="absolute" top={0} bottom={0} left={0} right={0} backgroundColor={c.bgScrim} />
      <ModalSurface width={CELL_VIEWER_WIDTH} paddingY={1} elevated>
        <box height={1} flexDirection="row">
          <text fg={c.textBright}>
            {tableName}.{columnName}
          </text>
          <text fg={c.textMuted}>
            {" "}
            · row {position} of {total}
            {columnType ? ` · ${columnType}` : ""}
          </text>
        </box>
        <box height={1} />
        {shown.map((line, index) => (
          <box key={top + index} height={1} flexDirection="row">
            <text fg={c.text}>{line.length > 0 ? line : " "}</text>
          </box>
        ))}
        {scrollable ? (
          <>
            <box height={1} />
            <text fg={c.textMuted}>
              ↓ lines {top + 1}–{top + shown.length} of {lines.length}
            </text>
          </>
        ) : null}
        <box height={1} />
        <box height={1} flexDirection="row">
          <text fg={c.textMuted}> j/k scroll · g/G ends · e/Esc close </text>
        </box>
      </ModalSurface>
    </box>
  )
}
