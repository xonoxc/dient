/**
 * Plain-text overlay used by the schema viewer and the Redis command console.
 *
 * The explorer owns the keyboard, the scroll offset, and the open/close state,
 * exactly like `CellViewer`; this component only wraps and paints the document.
 */
import { useTheme } from "@/theme-context"
import { ModalSurface } from "@/ui/modal-surface"
import { wrapText } from "@/explorer/cell-viewer"

export const TEXT_VIEWER_WIDTH = 96

/** Keep the modal inside an 80/88-column terminal; a fixed 96 clips its left
 *  edge on narrow screens and hides the very title the user opened it for. */
export const textViewerWidth = (terminalWidth: number): number =>
  Math.max(40, Math.min(TEXT_VIEWER_WIDTH, terminalWidth - 4))

export const textViewerTextWidth = (viewerWidth: number): number => Math.max(32, viewerWidth - 4)

export interface TextViewerProps {
  readonly title: string
  readonly text: string
  readonly visibleRows: number
  readonly offset: number
  /** Outer modal width; callers use `textViewerWidth` so scrolling matches. */
  readonly width: number
  /** Hint for the close key; the schema viewer and command console differ. */
  readonly closeHint?: string
}

export function TextViewer({ title, text, visibleRows, offset, width, closeHint = "Esc close" }: TextViewerProps) {
  const theme = useTheme()
  const c = theme.colors
  const lines = wrapText(text, textViewerTextWidth(width))
  const room = Math.max(1, visibleRows)
  const top = Math.max(0, Math.min(offset, Math.max(0, lines.length - room)))
  const shown = lines.slice(top, top + room)
  const scrollable = lines.length > room

  return (
    <box position="absolute" top={0} bottom={0} left={0} right={0} alignItems="center" justifyContent="center">
      <box position="absolute" top={0} bottom={0} left={0} right={0} backgroundColor={c.bgScrim} />
      <ModalSurface width={width} paddingY={1} elevated maxHeight={Math.max(8, room + 6)}>
        <box height={1} flexDirection="row">
          <text fg={c.accent}>{title}</text>
          <box flexGrow={1} />
          {scrollable ? (
            <text fg={c.textMuted}>{`lines ${top + 1}–${top + shown.length} of ${lines.length}`}</text>
          ) : null}
        </box>
        <box height={1} />
        {shown.map((line, index) => (
          <box key={top + index} height={1} flexDirection="row">
            <text fg={c.text}>{line.length > 0 ? line : " "}</text>
          </box>
        ))}
        <box height={1} />
        <text fg={c.textMuted}>{` j/k scroll · g/G ends · ${closeHint} `}</text>
      </ModalSurface>
    </box>
  )
}
