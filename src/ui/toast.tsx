/**
 * Inline transient notice. Auto-dismiss timeouts are owned by `ToastProvider`;
 * the newest notice shares one row with the app chrome instead of floating
 * over and obscuring the workspace.
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
  const toast = toasts[toasts.length - 1]
  if (!toast) return null

  return (
    <box height={1} flexDirection="row" alignItems="center" paddingX={1} overflow="hidden">
      <text fg={theme.colors[TOAST_COLOR[toast.kind]]}>● </text>
      <text fg={theme.colors.text} truncate>{toast.text}</text>
    </box>
  )
}
