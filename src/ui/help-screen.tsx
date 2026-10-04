/** Compact, truthful key reference for the current screen. */
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useTheme } from "@/theme-context"
import { useRouter } from "@/app-context"
import { ModalSurface } from "@/ui/modal-surface"
import { normalModeKey } from "@/ui/text-entry"

type Binding = readonly [string, string]

const EXPLORER: ReadonlyArray<Binding> = [
  ["j / k (↓ / ↑)", "move down / up"],
  ["gg / G", "first / last"],
  ["h / l", "focus sidebar / table"],
  ["← / →", "previous / next col"],
  ["Enter", "preview the row"],
  ["i", "edit row in $EDITOR"],
  ["V", "start row selection"],
  ["y", "copy the selection"],
  ["Space", "open quick finder"],
  ["/", "filter current page"],
  ["n / N", "next / prev match"],
  ["Ctrl+f / Ctrl+b", "next / prev page"],
  ["Tab", "next connection"],
  ["s", "settings"],
]

const SETTINGS: ReadonlyArray<Binding> = [
  ["j / ↓", "move down"],
  ["k / ↑", "move up"],
  ["gg / G", "first / last"],
  ["Enter", "expand / select"],
  ["a", "add database"],
  ["p", "paste connection URI"],
  ["Shift+P", "add project"],
  ["r", "rename"],
  ["t", "test connection"],
  ["d", "delete"],
  ["e", "return to explorer"],
]

const COMMANDS: ReadonlyArray<Binding> = [
  ["q", "quit (normal mode)"],
  [":e <table>", "open a table"],
  [":connect <name>", "switch database"],
  [":refresh", "reload current table"],
  [":settings", "open settings"],
  [":help", "show this reference"],
  [":w", "flush pending changes"],
  [":q", "quit / back"],
]

const halves = <T,>(values: ReadonlyArray<T>): readonly [ReadonlyArray<T>, ReadonlyArray<T>] => {
  const split = Math.ceil(values.length / 2)
  return [values.slice(0, split), values.slice(split)]
}

export function HelpScreen() {
  const theme = useTheme()
  const router = useRouter()
  const { width, height } = useTerminalDimensions()
  const c = theme.colors

  useKeyboard(e => {
    const key = normalModeKey(e)
    if (router.helpOpen && (key === "?" || key === "escape" || key === "Escape" || key === "\u001b")) {
      router.closeHelp()
    }
  })

  if (!router.helpOpen) return null

  const isSettings = router.screen === "settings"
  const bindings = isSettings ? SETTINGS : EXPLORER
  const [left, right] = halves(bindings)
  const panelWidth = Math.max(36, Math.min(76, width - 4))
  const columnWidth = Math.floor((panelWidth - 4) / 2)
  const keyWidth = Math.min(18, Math.max(11, columnWidth - 12))
  const [commandLeft, commandRight] = halves(COMMANDS)

  return (
    <box
      position="absolute"
      width="100%"
      height="100%"
      alignItems="center"
      justifyContent="center"
      backgroundColor={c.bg}
    >
      <ModalSurface width={panelWidth} maxHeight={Math.max(10, height - 2)}>
        <box flexDirection="row" alignItems="center">
          <text fg={c.accent}>dient · keybindings</text>
          <box flexGrow={1} />
          <text fg={c.textMuted}>?</text>
        </box>
        <text fg={c.textMuted}>{isSettings ? "settings" : "explorer"} · Vim keys and arrows · Esc closes</text>
        <box height={1} />
        <text fg={c.accent}>NAVIGATION & ACTIONS</text>
        <box flexDirection="row">
          <box width={columnWidth} flexDirection="column">
            {left.map(([key, action]) => (
              <BindingRow key={key} keyName={key} action={action} keyWidth={keyWidth} />
            ))}
          </box>
          <box width={columnWidth} flexDirection="column">
            {right.map(([key, action]) => (
              <BindingRow key={key} keyName={key} action={action} keyWidth={keyWidth} />
            ))}
          </box>
        </box>
        <box height={1} />
        <text fg={c.accent}>COMMANDS</text>
        <box flexDirection="row">
          <box width={columnWidth} flexDirection="column">
            {commandLeft.map(([key, action]) => (
              <BindingRow key={key} keyName={key} action={action} keyWidth={keyWidth} />
            ))}
          </box>
          <box width={columnWidth} flexDirection="column">
            {commandRight.map(([key, action]) => (
              <BindingRow key={key} keyName={key} action={action} keyWidth={keyWidth} />
            ))}
          </box>
        </box>
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
