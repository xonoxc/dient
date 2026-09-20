/**
 * Bottom status bar. One row, always visible, with a colored zone per section:
 *   - the current vim mode (in the mode's color),
 *   - the brand (accent),
 *   - the active connection, table, and row counts (bright text),
 *   - quick key hints on the right (muted).
 *
 * No backgrounds are painted: every zone is text colored through the ANSI
 * palette slots the terminal itself renders, so the strip always follows the
 * active colorscheme regardless of theme. The total width is budgeted
 * up-front: OpenTUI flex rows do not truncate overflowing text reliably, so
 * each zone is truncated in JS to a fixed cap that always fits 80 columns.
 * When space is tight the location is dropped first — the row count is the
 * part users need most.
 */
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
  readonly hints?: ReadonlyArray<string>
}

const MODE_LABEL: Record<VimMode, string> = {
  normal: "NORMAL",
  insert: "INSERT",
  visual: "VISUAL",
}

/* Fixed credits: mode(9) + brand(8) + hints(30) + page padding(2×2) leaves the
 * middle. Budget the worst case (80-col terminal, app padded on both sides): */
const HINTS_MAX = 30
const MID_MAX = 80 - 4 - 9 - 8 - HINTS_MAX

export function StatusBar(props: StatusBarProps) {
  const theme = useTheme()
  const c = theme.colors
  const modeColor = props.mode === "insert" ? c.success : props.mode === "visual" ? c.warning : c.accent
  const mode = ` ${MODE_LABEL[props.mode]} `

  const location = [props.connection, props.database].filter(Boolean).join("@")
  const locationText = location ? (props.engine ? `${location} · ${props.engine}` : location) : ""
  const tableInfo = props.table ? ` ${props.table}` : ""
  const rowInfo =
    props.rows !== undefined
      ? props.total !== undefined && props.total > props.rows
        ? ` ${props.rows} / ${props.total} rows`
        : ` ${props.rows} row${props.rows === 1 ? "" : "s"}`
      : ""

  /* Keep table/rows (rightmost) whole; drop location only if it does not fit. */
  const rightBits = `${tableInfo}${rowInfo}`
  const leftBits = locationText.slice(0, Math.max(0, MID_MAX - rightBits.length)).trimEnd()
  const mid = `${leftBits}${rightBits}`

  const hints = (props.hints ?? []).join("  ").slice(0, HINTS_MAX)

  return (
    <box height={1} flexDirection="row" alignItems="center">
      <text fg={modeColor}>{mode}</text>
      <text fg={c.accent}>dient</text>
      {mid ? <text fg={c.textBright}> {mid}</text> : null}
      <box flexGrow={1} />
      {hints ? <text fg={c.textMuted}> {hints}</text> : null}
    </box>
  )
}
