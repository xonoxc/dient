/**
 * App shell. Composes every provider, routes between the explorer and settings
 * screens, and renders the shared chrome: status bar (bottom), command line
 * (bottom, above the status bar), toasts, confirmation modal, and the help
 * overlay. Global keys that belong to the shell (`:` opens a command, `?`
 * opens help) live here; screen-specific keys live in the screens.
 */
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useTheme } from "@/theme-context"
import type { ThemeService } from "@/theme"
import { ThemeProvider } from "@/theme-context"
import {
  CommandLineProvider,
  CommandBusProvider,
  DialogProvider,
  RouterProvider,
  ServicesProvider,
  SessionProvider,
  ToastProvider,
  useCommandBus,
  useCommandLine,
  TextInputProvider,
  ConfigRevisionProvider,
  useTextInput,
  useDialog,
  useRouter,
  useServices,
  useSessionStatus,
  useToasts,
  type AppCommand,
  type AppServices,
} from "@/app-context"
import { ExplorerScreen } from "@/explorer/explorer-screen"
import { SettingsScreen } from "@/settings/settings-screen"
import { StatusBar } from "@/status-bar"
import { ToastView } from "@/ui/toast"
import { ModalView } from "@/ui/modal"
import { HelpScreen } from "@/ui/help-screen"
import { normalModeKey, resolveTypedChar } from "@/ui/text-entry"
import { windowTail } from "@/ui/text-window"

export default function App({ theme, services }: { theme: ThemeService; services: AppServices }) {
  return (
    <ThemeProvider theme={theme}>
      <ServicesProvider services={services}>
        <RouterProvider>
          <ToastProvider>
            <DialogProvider>
              <SessionProvider>
                <CommandBusProvider>
                  <CommandLineProvider>
                    <ConfigRevisionProvider>
                      <TextInputProvider>
                        <Shell />
                      </TextInputProvider>
                    </ConfigRevisionProvider>
                  </CommandLineProvider>
                </CommandBusProvider>
              </SessionProvider>
            </DialogProvider>
          </ToastProvider>
        </RouterProvider>
      </ServicesProvider>
    </ThemeProvider>
  )
}

interface ShellCommand {
  readonly id: string
  readonly help: string
  readonly match: (text: string) => boolean
  readonly run: (text: string) => void
}

function Shell() {
  const theme = useTheme()
  const c = theme.colors
  const router = useRouter()
  const dialog = useDialog()
  const commandLine = useCommandLine()
  const textInput = useTextInput()
  const status = useSessionStatus().status
  const bus = useCommandBus()
  const toasts = useToasts()

  const commands: ReadonlyArray<ShellCommand> = [
    {
      id: "setting-refresh",
      help: ":w — flush pending changes",
      match: text => /^(w|write|save)$/.test(text.trim()),
      run: () => toasts.push("info", "no pending changes to save"),
    },
    {
      id: "settings",
      help: ":settings — open settings",
      match: text => text.trim() === "settings",
      run: () => router.setScreen("settings"),
    },
    {
      id: "explorer",
      help: ":explorer — back to browsing",
      match: text => text.trim() === "explorer",
      run: () => router.setScreen("explorer"),
    },
    {
      id: "help",
      help: ":help — keybindings",
      match: text => text.trim() === "help",
      run: () => router.openHelp(),
    },
    {
      id: "quit",
      help: ":q — quit (from settings, back to explorer)",
      match: text => /^(q|quit)$/.test(text.trim()),
      run: () => {
        if (router.screen === "settings") router.setScreen("explorer")
        else process.exit(0)
      },
    },
  ]

  /* Unknown commands get a helpful toast instead of silent nothing. */
  /* Context-sensitive (explorer) commands run/match before the global shell
     ones, so the palette strip leads with `:e <table>` / `:connect` / `:refresh`
     — the commands users most need discoverability for. No matcher collides. */
  const allCommands = [...bus.commands, ...commands]
  const fallback: AppCommand = {
    id: "unknown",
    help: "",
    match: () => false,
    run: text => void text,
  }
  const matchedCommand = (text: string): AppCommand => allCommands.find(command => command.match(text)) ?? fallback

  /* The command line is owned by the shell, so its key handling lives here on
     an always-mounted hook. A per-line component could only register after `:`
     mounts it, silently dropping the rest of the typed chord. */
  useKeyboard(e => {
    const key = normalModeKey(e)

    /* INSERT mode is resolved first, before any NORMAL binding is consulted.
       `route` is exactly-once per key event, so whichever subscriber runs first
       delivers the key to the text owner and the others stand down. The command
       line is a text surface too, but the shell owns it, so it is checked
       alongside the registered owner. */
    if (textInput.route(e)) return

    if (commandLine.open) {
      if (key === "escape" || key === "Escape" || key === "\u001b") {
        commandLine.closeLine()
        return
      }
      /* Tab completes the command name to the longest common prefix across
         every registered command (e.g. ":sett" → ":settings "). */
      if (key === "tab") {
        const typed = commandLine.text.trim().replace(/^:/, "")
        const keywords = allCommands
          .map(command => command.help.match(/^:(\S+)/)?.[1] ?? "")
          .filter(keyword => keyword.startsWith(typed))
        if (keywords.length > 0 && typed.length > 0) {
          let completed = keywords[0]!
          for (const keyword of keywords.slice(1)) {
            let i = 0
            while (i < completed.length && i < keyword.length && completed[i] === keyword[i]) i++
            completed = completed.slice(0, i)
          }
          if (completed.length > typed.length) commandLine.replaceText(`${completed} `)
        }
        return
      }
      if (key === "return" || key === "enter" || key === "\r") {
        const text = commandLine.text.trim()
        if (!text) {
          commandLine.closeLine()
          return
        }
        const matched = matchedCommand(text)
        matched.run(text)
        if (matched.id === "unknown") toasts.push("error", `unknown command: ${text}`)
        commandLine.closeLine()
        return
      }
      if (key === "backspace") {
        commandLine.backspace()
        return
      }
      const char = resolveTypedChar(e)
      if (char !== null) {
        commandLine.typeChar(char)
        return
      }
      return
    }

    if (dialog.dialog || router.helpOpen) return
    if (key === "?") {
      router.openHelp()
    } else if (key === ":") {
      commandLine.openLine()
    }
  })

  const screen = router.screen === "settings" ? <SettingsScreen /> : <ExplorerScreen />

  return (
    <box flexGrow={1} flexDirection="column" backgroundColor={c.bg}>
      <box flexGrow={1} flexDirection="column" paddingX={1} paddingY={1}>
        <box flexGrow={1} flexDirection="row">
          {screen}
        </box>
        <CommandBar commands={allCommands} />
        <ToastView />
        <StatusBar
          mode={status.mode}
          engine={status.engine}
          connection={status.connection}
          database={status.database}
          table={status.table}
          rows={status.rows}
          total={status.total}
          selected={status.selected}
          rowStart={status.rowStart}
          hints={status.hints}
        />
      </box>
      <ModalView />
      <HelpScreen />
    </box>
  )
}

function CommandBar({ commands }: { commands: ReadonlyArray<ShellCommand> }) {
  const theme = useTheme()
  const c = theme.colors
  const commandLine = useCommandLine()
  const { width } = useTerminalDimensions()

  if (!commandLine.open) return null

  /* The palette is one line; cut the help text deterministically in JS so the
     strip never flips which commands it shows (OpenTUI truncate is width-
     dependent). The bus commands lead (see Shell.allCommands). */
  const paletteText = commands
    .map(x => x.help)
    .join("  ")
    .slice(0, 64)

  /* App `paddingX={1}` plus this bar's own `paddingX={1}` leave `width - 4`
     cells. The palette yields at most half of them so a long command can still
     show its tail next to the cursor. */
  const contentWidth = Math.max(1, width - 4)
  const paletteReserve = Math.min(paletteText.length, Math.floor(contentWidth / 2))
  const commandBudget = Math.max(1, contentWidth - 1 - 1 - paletteReserve - 1)

  return (
    <box
      height={1}
      flexDirection="row"
      alignItems="center"
      paddingX={1}
      backgroundColor={c.bgSurface}
      overflow="hidden"
    >
      <text fg={c.success}>:</text>
      <box flexDirection="row">
        <text fg={c.textBright}>{windowTail(commandLine.text, commandBudget)}</text>
        <text fg={c.accent}>▍</text>
      </box>
      <box flexGrow={1} />
      <text fg={c.textMuted} truncate>
        {paletteText}
      </text>
    </box>
  )
}

export type { AppServices }
