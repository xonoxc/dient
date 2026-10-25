/**
 * Confirmation modal. Renders a centered dialog when `DialogProvider` has a
 * pending promise; Enter/Y confirms, Esc/N cancels. A palette-derived scrim
 * dims the screen behind the elevated card while keeping the workspace visible.
 */
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useTheme } from "@/theme-context"
import { useDialog } from "@/app-context"
import { ModalSurface } from "@/ui/modal-surface"
import { normalModeKey } from "@/ui/text-entry"

/** A body taller than this is a bug in the message, not a layout to honour. */
const BODY_MAX_LINES = 6

/**
 * How many rows a body needs once wrapped.
 *
 * Counting newlines alone is wrong: a long single-line message — which is what
 * every error here is — counts as one row, and the box would clip it after the
 * first wrap. The estimate only sets the box height, so a slightly generous
 * number is harmless while an undercount silently hides text.
 */
const bodyRows = (text: string, width: number): number =>
  text.split("\n").reduce((total, line) => total + Math.max(1, Math.ceil(line.length / width)), 0)

export function ModalView() {
  const theme = useTheme()
  const { dialog } = useDialog()
  const { width, height } = useTerminalDimensions()
  const c = theme.colors
  const panelWidth = Math.max(24, Math.min(60, width - 4))
  const contentWidth = Math.max(1, panelWidth - 4)
  const bodyHeight = Math.min(BODY_MAX_LINES, Math.max(1, height - 8))

  useKeyboard(e => {
    if (!dialog) return
    const key = normalModeKey(e)
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
    <box position="absolute" width="100%" height="100%" alignItems="center" justifyContent="center">
      <box position="absolute" top={0} bottom={0} left={0} right={0} backgroundColor={c.bgScrim} />
      <ModalSurface width={panelWidth} paddingY={1} maxHeight={height - 2} elevated>
        <text fg={dialog.options.danger ? c.error : c.textBright}>{dialog.options.title}</text>
        {/* Height-capped so a body of any length cannot grow the panel until
           the closing border is pushed off screen. Horizontal wrapping is
           already handled by the fixed-width box; the newline count is what
           drove the height, which is why a raw multi-line rejection dump used
           to swallow the whole terminal. */}
        <box height={Math.min(bodyHeight, bodyRows(dialog.options.body, contentWidth))}>
          <text fg={c.text}>{dialog.options.body}</text>
        </box>
        <box height={1} />
        <box flexDirection="row">
          <text fg={c.textMuted}>[(Y)es / (N)o] </text>
          <text fg={dialog.options.danger ? c.error : c.success}>{dialog.options.okLabel ?? "confirm"}</text>
        </box>
      </ModalSurface>
    </box>
  )
}
