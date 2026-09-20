/**
 * Confirmation modal. Renders a centered dialog when `DialogProvider` has a
 * pending promise; Enter/Y confirms, Esc/N cancels. Interaction while open is
 * blocked by simply covering the viewport with an opaque sheet.
 */
import { useKeyboard } from "@opentui/react"
import { useTheme } from "@/theme-context"
import { useDialog } from "@/app-context"

export function ModalView() {
  const theme = useTheme()
  const { dialog } = useDialog()
  const c = theme.colors

  useKeyboard(e => {
    if (!dialog) return
    const key = e.name
    if (key === "enter" || key === "y" || key === "Y") {
      dialog.resolve(true)
    } else if (key === "escape" || key === "Escape" || key === "\u001b" || key === "n" || key === "N") {
      dialog.resolve(false)
    } else {
      e.preventDefault()
    }
  })

  if (!dialog) return null

  return (
    <box
      position="absolute"
      width="100%"
      height="100%"
      alignItems="center"
      justifyContent="center"
      backgroundColor={c.bg}
    >
      <box
        flexDirection="column"
        borderStyle="single"
        borderColor={dialog.options.danger ? c.error : c.borderFocused}
        paddingX={1}
        paddingY={0}
        width={60}
      >
        <text fg={dialog.options.danger ? c.error : c.textBright}>{dialog.options.title}</text>
        <text fg={c.text}>{dialog.options.body}</text>
        <box height={1} />
        <box flexDirection="row">
          <text fg={c.textMuted}>[(Y)es / (N)o] </text>
          <text fg={dialog.options.danger ? c.error : c.success}>{dialog.options.okLabel ?? "confirm"}</text>
        </box>
      </box>
    </box>
  )
}
