/** Compact, truthful key reference for the current screen.
 *
 *  Every mode the app has is listed here — explorer, the RabbitMQ workspace,
 *  settings, and the `:` commands — and the list scrolls with j/k, so the
 *  reference stays complete instead of being trimmed to fit short terminals.
 */
import { useEffect, useMemo, useState } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useTheme } from "@/theme-context"
import { useRouter } from "@/app-context"
import { ModalSurface } from "@/ui/modal-surface"
import { normalModeKey } from "@/ui/text-entry"

type Binding = readonly [string, string]

const EXPLORER: ReadonlyArray<Binding> = [
  ["j / k (↓ / ↑)", "move / scroll value"],
  ["gg / G", "first / last (or value ends)"],
  ["1 / 2", "focus sidebar / table"],
  ["\\", "toggle sidebar"],
  ["h / l", "scroll columns left / right"],
  ["← / →", "previous / next col"],
  ["Enter", "open key / preview row"],
  ["Esc", "back to Redis keys"],
  ["i", "edit row/value; rename Redis key"],
  ["a", "new Redis key ($EDITOR form)"],
  ["T", "set TTL on a Redis key ($EDITOR form)"],
  ["r", "reload current table/value"],
  ["dd / d", "delete row / visual selection"],
  ["e", "view full cell value"],
  ["D", "show table schema (columns, indexes, DDL)"],
  ["V", "start row selection"],
  ["y", "copy the selection"],
  ["Space", "open quick finder"],
  ["/", "filter current page"],
  ["n / N", "next / prev match"],
  ["Ctrl+f / Ctrl+b", "next / prev page"],
  ["Tab", "next connection"],
  ["s", "settings"],
  ["?", "show this reference"],
]

const RABBITMQ: ReadonlyArray<Binding> = [
  ["Tab", "next tab (queues / exchanges / bindings / messages)"],
  ["Enter / m", "peek a queue's messages"],
  ["a", "create queue / exchange"],
  ["p", "publish a message"],
  ["b", "bind a queue to an exchange"],
  ["x", "purge a queue"],
  ["M", "move next ready message to another queue"],
  ["d", "delete queue / exchange"],
  ["u", "unbind a binding"],
  ["[ / ]", "move queue up / down"],
  ["s", "sort queues by name / messages"],
  ["o", "reverse message order"],
  ["y", "copy message payload"],
  ["i", "edit and republish a message"],
  ["S", "settings"],
  ["r", "refresh"],
]

const SETTINGS: ReadonlyArray<Binding> = [
  ["j / ↓", "move down"],
  ["k / ↑", "move up"],
  ["gg / G", "first / last"],
  ["1 / 2", "focus workspaces / details"],
  ["Enter", "expand / select"],
  ["a", "add database"],
  ["p", "paste connection URI"],
  ["Shift+P", "add project"],
  ["e", "edit project or database"],
  ["r", "rename project or database"],
  ["m", "move database to another project"],
  ["t", "test connection"],
  ["d", "delete"],
  ["Shift+E", "return to explorer"],
  ["?", "show this reference"],
]

const COMMANDS: ReadonlyArray<Binding> = [
  ["q / Q", "quit (normal mode)"],
  [":e <table>", "open a table"],
  [":connect <name>", "switch database"],
  [":refresh", "reload current table"],
  [":schema", "show table schema"],
  [":redis <command>", "run a Redis command"],
  [":upgrade", "install pending update"],
  [":ignore-update", "skip pending update"],
  [":version", "show app version"],
  [":settings", "open settings"],
  [":help", "show this reference"],
  [":w", "flush pending changes"],
  [":q", "quit / back"],
]

export type HelpRow =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "binding"; readonly keyName: string; readonly action: string }

/** The whole reference for one screen, flattened in display order. Exported
 *  so tests can assert completeness without scrolling a real terminal. */
export const helpRows = (isSettings: boolean): ReadonlyArray<HelpRow> => {
  const rows: HelpRow[] = []
  const pushSection = (heading: string, bindings: ReadonlyArray<Binding>): void => {
    rows.push({ kind: "heading", text: heading })
    for (const [keyName, action] of bindings) rows.push({ kind: "binding", keyName, action })
  }
  if (isSettings) {
    pushSection("SETTINGS", SETTINGS)
  } else {
    pushSection("EXPLORER", EXPLORER)
    pushSection("RABBITMQ WORKSPACE", RABBITMQ)
  }
  pushSection("COMMANDS", COMMANDS)
  return rows
}

/** Title, subtitle, the gap above the rows, the gap above the hint, hint. */
const CHROME_ROWS = 5

export function HelpScreen() {
  const theme = useTheme()
  const router = useRouter()
  const { width, height } = useTerminalDimensions()
  const c = theme.colors

  const isSettings = router.screen === "settings"
  const rows = useMemo(() => helpRows(isSettings), [isSettings])

  const panelWidth = Math.max(36, Math.min(76, width - 4))
  const keyWidth = Math.min(18, Math.max(11, Math.floor((panelWidth - 4) / 3)))
  const budget = Math.max(10, height - 2)
  const visibleRows = Math.max(1, Math.min(rows.length, budget - CHROME_ROWS))

  const [offset, setOffset] = useState(0)
  useEffect(() => {
    /* Reopening help, or toggling between screens, starts at the top. */
    setOffset(0)
  }, [router.helpOpen, isSettings])
  const top = Math.max(0, Math.min(offset, rows.length - visibleRows))

  useKeyboard(e => {
    if (!router.helpOpen) return
    const key = normalModeKey(e)
    if (key === "?" || key === "escape" || key === "Escape" || key === "\u001b") {
      router.closeHelp()
    } else if (key === "j" || key === "down") {
      setOffset(Math.min(rows.length - visibleRows, top + 1))
    } else if (key === "k" || key === "up") {
      setOffset(Math.max(0, top - 1))
    } else if (key === "g") {
      setOffset(0)
    } else if (key === "G") {
      setOffset(Math.max(0, rows.length - visibleRows))
    }
  })

  if (!router.helpOpen) return null

  const shown = rows.slice(top, top + visibleRows)
  const scrollable = rows.length > visibleRows

  return (
    <box
      position="absolute"
      width="100%"
      height="100%"
      alignItems="center"
      justifyContent="center"
      backgroundColor={c.bg}
    >
      <ModalSurface width={panelWidth} maxHeight={budget} paddingY={0}>
        <box flexDirection="row" alignItems="center">
          <text fg={c.accent}>dient · keybindings</text>
          <box flexGrow={1} />
          <text fg={c.textMuted}>{scrollable ? `rows ${top + 1}–${top + shown.length} of ${rows.length}` : "?"}</text>
        </box>
        <text fg={c.textMuted}>
          {isSettings ? "settings" : "explorer"} · section keys apply in their mode · Esc closes
        </text>
        <box height={1} />
        {shown.map((row, index) =>
          row.kind === "heading" ? (
            <text key={`${top + index}-${row.text}`} fg={c.accent}>
              {row.text}
            </text>
          ) : (
            <BindingRow
              key={`${top + index}-${row.keyName}`}
              keyName={row.keyName}
              action={row.action}
              keyWidth={keyWidth}
            />
          )
        )}
        <box height={1} />
        <text fg={c.textMuted}>{scrollable ? " j/k scroll · g/G ends · Esc close " : " Esc close "}</text>
      </ModalSurface>
    </box>
  )
}

function BindingRow({ keyName, action, keyWidth }: { keyName: string; action: string; keyWidth: number }) {
  const { colors: c } = useTheme()
  return (
    <box height={1} flexDirection="row" overflow="hidden">
      <text fg={c.textBright} width={keyWidth} truncate>
        {keyName}
      </text>
      <text fg={c.textMuted} truncate>
        {action}
      </text>
    </box>
  )
}
