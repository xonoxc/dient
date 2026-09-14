import { createContext, useContext, type ReactNode } from "react"
import type { ThemeService } from "@/theme"

const ThemeContext = createContext<ThemeService | null>(null)

export function ThemeProvider({ theme, children }: { theme: ThemeService; children?: ReactNode }) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeService {
  const theme = useContext(ThemeContext)
  if (!theme) {
    throw new Error("useTheme() used outside of a <ThemeProvider>")
  }
  return theme
}
