import { useEffect, useState } from "react"
import { useTheme } from "@/theme-context"

const FRAMES = ["◐", "◓", "◑", "◒"] as const

/** A small, terminal-safe activity indicator. The timer exists only while the
 * indicator is mounted, so idle screens have no animation work scheduled. */
export function LoadingIndicator({ label }: { label: string }) {
  const { colors } = useTheme()
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setFrame(current => (current + 1) % FRAMES.length), 110)
    return () => clearInterval(timer)
  }, [])

  return (
    <box flexDirection="row" alignItems="center">
      <text fg={colors.accent}>{FRAMES[frame]}</text>
      <text fg={colors.textMuted}> {label}</text>
    </box>
  )
}
