/**
 * Redis-specific value views. Collection keys use the shared data table; these
 * two panels cover the shapes a table would flatten badly: a string is one long
 * value that wants wrapping and line scrolling, and a stream is a sequence of
 * timestamped entries whose fields read better as cards than as a wide row.
 *
 * Both panels are pure views. The explorer owns the keyboard and the scrollbox
 * ref, exactly like `RowPreview` and `CellViewer` own their open/scroll state.
 */
import type { RefObject } from "react"
import { useEffect } from "react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTheme } from "@/theme-context"
import { formatCell } from "@/table/use-table"
import { wrapText } from "@/explorer/cell-viewer"
import type { RedisStreamEntry } from "@/redis/types"

export interface RedisTextPanelProps {
  readonly value: string
  readonly note?: string
  readonly width: number
  readonly scrollRef: RefObject<ScrollBoxRenderable | null>
}

/* A 64 KB value can contain tens of thousands of newlines. Every rendered line
   is a real component, so cap the visible document rather than freezing the
   frame when someone opens a pathological string. */
const MAX_TEXT_LINES = 4_000

export function RedisTextPanel({ value, note, width, scrollRef }: RedisTextPanelProps) {
  const { colors: c } = useTheme()
  const body = value.length > 0 ? value : "(empty string)"
  const wrapped = wrapText(body, Math.max(8, width - 6))
  const lines = wrapped.slice(0, MAX_TEXT_LINES)
  const lineNote =
    wrapped.length > MAX_TEXT_LINES
      ? `showing first ${MAX_TEXT_LINES.toLocaleString()} of ${wrapped.length.toLocaleString()} wrapped lines`
      : undefined
  const footer = [note, lineNote].filter(Boolean).join(" · ")
  /* A new key (or a paged value) starts at the top; the scrollbox is reused
     across keys, so without this the reader would inherit the last offset. */
  useEffect(() => {
    const box = scrollRef.current
    if (box) box.scrollTop = 0
  }, [value, scrollRef])
  return (
    <scrollbox
      ref={scrollRef}
      flexGrow={1}
      scrollY
      verticalScrollbarOptions={{ visible: false }}
      backgroundColor={c.bg}
    >
      <box flexDirection="column" paddingX={2} paddingY={1}>
        {lines.map((line, index) => (
          <text key={index} fg={c.text}>
            {line.length > 0 ? line : " "}
          </text>
        ))}
        {footer ? (
          <>
            <box height={1} />
            <text fg={c.textMuted}>{`— ${footer}`}</text>
          </>
        ) : null}
      </box>
    </scrollbox>
  )
}

export interface RedisStreamPanelProps {
  readonly entries: ReadonlyArray<RedisStreamEntry>
  readonly width: number
  readonly scrollRef: RefObject<ScrollBoxRenderable | null>
}

export function RedisStreamPanel({ entries, width, scrollRef }: RedisStreamPanelProps) {
  const { colors: c } = useTheme()
  /* Stream pages replace the card list wholesale, so reset the shared scrollbox
     to the first entry rather than keeping the previous page's offset. */
  useEffect(() => {
    const box = scrollRef.current
    if (box) box.scrollTop = 0
  }, [entries, scrollRef])
  if (entries.length === 0) {
    return (
      <box flexGrow={1} paddingX={2} paddingY={1}>
        <text fg={c.textMuted}>No entries in this stream.</text>
      </box>
    )
  }

  /* Field names are usually short; cap the gutter so a pathological field name
     cannot squeeze every value off screen. */
  const longestField = entries.reduce(
    (max, entry) => entry.fields.reduce((fieldMax, [field]) => Math.max(fieldMax, field.length), max),
    0
  )
  const labelWidth = Math.max(8, Math.min(24, longestField))
  const valueWidth = Math.max(12, width - labelWidth - 8)

  return (
    <scrollbox
      ref={scrollRef}
      flexGrow={1}
      scrollY
      verticalScrollbarOptions={{ visible: false }}
      backgroundColor={c.bg}
    >
      <box flexDirection="column" paddingX={2} paddingY={1}>
        {entries.map((entry, index) => (
          <box key={`${entry.id}:${index}`} flexDirection="column">
            <text fg={c.accent}>{entry.id}</text>
            {entry.fields.length === 0 ? (
              <text fg={c.textMuted}> (no fields)</text>
            ) : (
              entry.fields.map(([field, value], fieldIndex) => {
                const label = formatCell(field).replace(/\s*\n\s*/g, " ↵ ")
                const clippedLabel =
                  label.length > labelWidth ? `${label.slice(0, Math.max(0, labelWidth - 1))}…` : label
                const display = formatCell(value).replace(/\s*\n\s*/g, " ↵ ")
                const clipped =
                  display.length > valueWidth ? `${display.slice(0, Math.max(0, valueWidth - 1))}…` : display
                return (
                  <box key={`${field}:${fieldIndex}`} height={1} flexDirection="row">
                    <text fg={c.textMuted} width={labelWidth + 2}>
                      {`  ${clippedLabel}`}
                    </text>
                    <text fg={c.text}>{clipped}</text>
                  </box>
                )
              })
            )}
            {index < entries.length - 1 ? <box height={1} /> : null}
          </box>
        ))}
      </box>
    </scrollbox>
  )
}
