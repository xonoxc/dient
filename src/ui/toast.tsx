/**
 * Toast stack, rendered fixed at the bottom of the viewport (just above the
 * status bar). Auto-dismiss timeouts are owned by `ToastProvider`, so this
 * component only draws whatever toasts are currently pending.
 */
import { useTheme } from "@/theme-context"
import { useToasts, type ToastKind } from "@/app-context"

const TOAST_COLOR: Record<ToastKind, "error" | "warning" | "success" | "info"> = {
  error: "error",
  warning: "warning",
  success: "success",
  info: "info",
} as const

export function ToastView() {
  const theme = useTheme()
  const { toasts } = useToasts()
  if (toasts.length === 0) return null

  return (
    <box position="absolute" bottom={1} right={0} flexDirection="column" alignItems="flex-end" paddingRight={2}>
      {toasts.map(toast => (
        <box key={toast.id} backgroundColor={theme.colors.bgSurface} paddingX={1} marginBottom={0}>
          <text fg={theme.colors[TOAST_COLOR[toast.kind]]}>
            {"● "}
            {toast.text}
          </text>
        </box>
      ))}
    </box>
  )
}