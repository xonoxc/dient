/**
 * Confirmation modal. Renders a centered dialog when `DialogProvider` has a
 * pending promise; Enter/Y confirms, Esc/N cancels. Interaction while open is
 * blocked by simply covering the viewport with an opaque sheet.
 */
import { useKeyboard } from "@opentui/react"
import { useTheme } from "@/theme-context"
import { useDialog } from "@/app-context"

/** A body taller than this is a bug in the message, not a layout to honour. */
const BODY_MAX_LINES = 6

/** Panel width 60, less one column of border and one of padding per side. */
const CONTENT_WIDTH = 56

/**
 * How many rows a body needs once wrapped.
 *
 * Counting newlines alone is wrong: a long single-line message — which is what
 * every error here is — counts as one row, and the box would clip it after the
 * first wrap. The estimate only sets the box height, so a slightly generous
 * number is harmless while an undercount silently hides text.
 */
const bodyRows = (text: string): number =>
  text
    .split("\n")
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / CONTENT_WIDTH)), 0)

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
        borderColor={dialog.options.danger ? c.error : c.border}
        paddingX={1}
        paddingY={0}
        width={60}
      >
        <text fg={dialog.options.danger ? c.error : c.textBright}>{dialog.options.title}</text>
        {/* Height-capped so a body of any length cannot grow the panel until
           the closing border is pushed off screen. Horizontal wrapping is
           already handled by the fixed-width box; the newline count is what
           drove the height, which is why a raw multi-line rejection dump used
           to swallow the whole terminal. */}
        <box height={Math.min(BODY_MAX_LINES, bodyRows(dialog.options.body))}>
          <text fg={c.text}>
            {dialog.options.body}
          </text>
        </box>
        <box height={1} />
        <box flexDirection="row">
          <text fg={c.textMuted}>[(Y)es / (N)o] </text>
          <text fg={dialog.options.danger ? c.error : c.success}>{dialog.options.okLabel ?? "confirm"}</text>
        </box>
      </box>
    </box>
  )
}
