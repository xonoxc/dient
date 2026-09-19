/**
 * Help overlay. A full viewport panel listing every keybinding, mode, and
 * command. `?` or Esc closes it. The panel is laid out in two columns so the
 * whole content fits a 24-row viewport without overflowing the top border.
 */
import { useKeyboard } from "@opentui/react"
import { useTheme } from "@/theme-context"
import { useRouter } from "@/app-context"

const BINDINGS: ReadonlyArray<[string, string, string]> = [
  ["NORMAL", "s", "open settings"],
  ["NORMAL", "e", "back to explorer (settings)"],
  ["NORMAL", "j / k", "move up / down"],
  ["NORMAL", "h / l", "focus sidebar / table"],
  ["NORMAL", "gg / G", "first / last row"],
  ["NORMAL", "i", "insert mode · edit cell / new row"],
  ["NORMAL", "v", "visual mode · select rows"],
  ["NORMAL", "Enter", "expand node · open table"],
  ["NORMAL", "dd", "delete row"],
  ["NORMAL", "Tab", "next connection"],
  ["NORMAL", ":", "command mode"],
  ["NORMAL", "/", "search"],
  ["NORMAL", "?", "help"],
  ["INSERT", "Esc", "back to normal"],
  ["INSERT", "Enter", "confirm edit"],
  ["INSERT", "Ctrl-c", "cancel edit"],
]

const COMMANDS: ReadonlyArray<[string, string]> = [
  [":e <table>", "open a table"],
  [":connect <name>", "switch connection"],
  [":refresh", "reload tables + data"],
  [":settings", "open settings"],
  [":help", "open help"],
  [":w", "save changes"],
  [":q", "quit"],
]

const pad = (text: string, width: number): string => text.padEnd(width).slice(0, width)

const half = <T,>(items: ReadonlyArray<T>): readonly [ReadonlyArray<T>, ReadonlyArray<T>] => {
  const split = Math.ceil(items.length / 2)
  return [items.slice(0, split), items.slice(split)]
}

function BindingCell({ entry }: { entry: readonly [string, string, string] }) {
  const theme = useTheme()
  const c = theme.colors
  const [mode, key, action] = entry
  return <text truncate>{`${pad(mode, 9)}${pad(key, 14)}${action}`}</text>
}

function CommandCell({ entry }: { entry: readonly [string, string] }) {
  const theme = useTheme()
  const c = theme.colors
  const [cmd, hint] = entry
  return <text truncate>{`${pad(cmd, 20)}${hint}`}</text>
}

export function HelpScreen() {
  const theme = useTheme()
  const router = useRouter()
  const c = theme.colors

  useKeyboard(e => {
    if (router.helpOpen && (e.name === "?" || e.name === "escape" || e.name === "Escape" || e.name === "\u001b")) {
      router.closeHelp()
    }
  })

  if (!router.helpOpen) return null

  const [bindingLeft, bindingRight] = half(BINDINGS)
  const [commandsLeft, commandsRight] = half(COMMANDS)

  return (
    <box position="absolute" width="100%" height="100%" alignItems="center" justifyContent="center" backgroundColor={c.bg}>
      <box borderStyle="rounded" borderColor={c.borderFocused} width={70} flexDirection="column" paddingX={1} paddingY={1}>
        <text fg={c.accent}> dient · keybindings </text>
        <text fg={c.textMuted}>vim-inspired browsing — press ? or Esc to close</text>

        <box height={1} />
        <box flexDirection="row">
          <box flexDirection="column" width={33}>
            {bindingLeft.map((entry, i) => (
              <BindingCell key={i} entry={entry} />
            ))}
          </box>
          <box flexDirection="column" width={33}>
            {bindingRight.map((entry, i) => (
              <BindingCell key={i} entry={entry} />
            ))}
          </box>
        </box>

        <box height={1} />
        <box flexDirection="row">
          <box flexDirection="column" width={33}>
            {commandsLeft.map((entry, i) => (
              <CommandCell key={i} entry={entry} />
            ))}
          </box>
          <box flexDirection="column" width={33}>
            {commandsRight.map((entry, i) => (
              <CommandCell key={i} entry={entry} />
            ))}
          </box>
        </box>
      </box>
    </box>
  )
}