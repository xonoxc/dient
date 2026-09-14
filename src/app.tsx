/**
 * Root component of the TUI. Everything rendered lives under this box.
 * The ThemeProvider bridges the Effect `Theme` service into React so
 * child components can read tokens via `useTheme()`.
 */
import { ThemeProvider, useTheme } from "@/theme-context"
import { makeTheme, DEFAULT_THEME_MODE } from "@/theme"
import type { ThemeService } from "@/theme"

export default function App({ theme }: { theme?: ThemeService } = {}) {
  return <ThemeProvider theme={theme ?? makeTheme(DEFAULT_THEME_MODE)}><Root /></ThemeProvider>
}

function Root() {
  const theme = useTheme()
  return (
    <box flexGrow={1} flexDirection="column" borderStyle="rounded" borderColor={theme.colors.border}>
      <text fg={theme.colors.text}>
        dient · {theme.mode}
      </text>
      <text fg={theme.colors.accent}>·</text>
      <text fg={theme.colors.textMuted}>colors adapt to your terminal palette</text>
    </box>
  )
}
