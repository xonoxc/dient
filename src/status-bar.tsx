/**
 * Bottom status bar. One row, always visible, with a colored zone per section:
 *   - the current vim mode (in the mode's ANSI color),
 *   - the brand (muted),
 *   - the active connection, table, and row counts (normal text),
 *   - quick key hints on the right (muted).
 *
 * No backgrounds are painted: every zone is text colored through the ANSI
 * palette slots the terminal itself renders, so the strip always follows the
 * active colorscheme regardless of theme.
 *
 * The zones are fitted against the *real* terminal width, because OpenTUI flex
 * rows do not truncate overflowing text reliably — anything that does not fit
 * has to be fitted here. The row figure is what users need most, so it is never
 * dropped: hints are shed first, whole, from the end, and only then is the
 * location ellipsized. A fixed 80-column budget instead would chop
 * `sample · sqlite` to `sample · sqli` on a wide terminal and leave the gap in
 * the middle looking like a bug.
 */
import { useTerminalDimensions } from "@opentui/react"
import { useTheme } from "@/theme-context"
import type { Engine } from "@/domain"
import type { VimMode } from "@/vim"

export interface StatusBarProps {
  readonly mode: VimMode
  readonly engine?: Engine
  readonly connection?: string
  readonly database?: string
  readonly table?: string
  readonly rows?: number
  readonly total?: number
  /** Row count of the open visual-mode selection, shown while it is open. */
  readonly selected?: number
  /** 1-based index of the first row on screen. Set when rows are paged in the
      database, so the count reads as a range rather than a total. */
  readonly rowStart?: number
  readonly hints?: ReadonlyArray<string>
}

const MODE_LABEL: Record<VimMode, string> = {
  normal: "NORMAL",
  insert: "INSERT",
  visual: "VISUAL",
}

const BRAND = "dient"
/** The page wraps the strip in `paddingX={1}`. */
const PAGE_PADDING = 2
/** Below this there is no honest way to lay four zones out in a row. */
const MIN_STRIP = 24
/** Hints take at most a third of the strip: past that they stop being a
    reminder and start being documentation. */
const HINT_SHARE = 3

/** Fit `text` into `room`, marking the cut with an ellipsis. */
const fit = (text: string, room: number): string => {
  if (room <= 0) return ""
  if (text.length <= room) return text
  return room === 1 ? text.slice(0, 1) : `${text.slice(0, room - 1)}…`
}

/** Take hints whole, from the front, so one is never cut mid-word ("V sele"). */
const fitHints = (hints: ReadonlyArray<string>, cap: number): string => {
  let out = ""
  for (const hint of hints) {
    const next = out ? `${out}  ${hint}` : hint
    if (next.length > cap) break
    out = next
  }
  return out
}

/** Drop the last hint that was shown, keeping the ones before it. */
const dropLastHint = (text: string): string => {
  const cut = text.lastIndexOf("  ")
  return cut === -1 ? "" : text.slice(0, cut)
}

export function StatusBar(props: StatusBarProps) {
  const theme = useTheme()
  const { width } = useTerminalDimensions()
  const c = theme.colors
  const modeColor = props.mode === "insert" ? c.success : props.mode === "visual" ? c.warning : c.accent
  const mode = ` ${MODE_LABEL[props.mode]} `

  const location = [props.connection, props.database].filter(Boolean).join("@")
  const locationText = location ? (props.engine ? `${location} · ${props.engine}` : location) : ""
  const tableInfo = props.table ? ` ${props.table}` : ""
  /* Paged: name the window, because "200 / 378" read as a progress figure and
     gave no hint that Ctrl+f could reach the rest. */
  const rowInfo =
    props.rows !== undefined
      ? props.rowStart !== undefined && props.total !== undefined && props.total > props.rows
        ? ` ${props.rowStart}-${props.rowStart + props.rows - 1} of ${props.total}`
        : props.total !== undefined && props.total > props.rows
          ? ` ${props.rows} / ${props.total} rows`
          : ` ${props.rows} row${props.rows === 1 ? "" : "s"}`
      : ""

  /* A visual selection is a count the user is actively changing, so it leads —
     placing it after the row figure would push it off a narrow terminal. */
  const selectionInfo =
    props.selected !== undefined && props.selected > 1 ? ` ${props.selected} selected` : ""

  /* Keep table/rows (rightmost) whole; drop location only if it does not fit. */
  const rightBits = `${tableInfo}${selectionInfo}${rowInfo}`
  const strip = Math.max(MIN_STRIP, width - PAGE_PADDING)
  const fixed = mode.length + BRAND.length + rightBits.length

  /* Hints yield before the location does, one whole hint at a time. */
  let hints = fitHints(props.hints ?? [], Math.floor(strip / HINT_SHARE))
  while (hints && fixed + hints.length + 2 > strip) {
    hints = dropLastHint(hints)
  }
  const hintsWidth = hints ? hints.length + 1 : 0
  const leftBits = fit(locationText, strip - fixed - hintsWidth - 1 - rightBits.length)
  const mid = `${leftBits}${rightBits}`

  return (
    <box height={1} flexDirection="row" alignItems="center">
      <text fg={modeColor}>{mode}</text>
      <text fg={c.textMuted}>{BRAND}</text>
      {mid ? <text fg={c.text}> {mid}</text> : null}
      <box flexGrow={1} />
      {hints ? <text fg={c.textMuted}> {hints}</text> : null}
    </box>
  )
}
