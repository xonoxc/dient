/**
 * Settings screen. Renders the config tree and a keyboard-driven add form.
 * Keyboard focus lives entirely here while this screen is active; the shell
 * routes back to the explorer through `:explorer`.
 */
import { useEffect } from "react"
import { useKeyboard } from "@opentui/react"
import { useTheme } from "@/theme-context"
import { useRouter, useCommandLine, useSessionStatus } from "@/app-context"
import { useSettings, type SettingsListItem } from "@/settings/use-settings"
import { FIELD_LABEL } from "@/settings/use-settings"

export function SettingsScreen() {
  const theme = useTheme()
  const c = theme.colors
  const router = useRouter()
  const commandLine = useCommandLine()
  const session = useSessionStatus()
  const settings = useSettings()

  const { items, cursor, form, draft, engine, field, fieldIndex, fieldCount, move, jump, toggle, add, remove, testConnection, submitForm, cancelForm, tab, typeChar, backspace, testing, completions } =
    settings

  useEffect(() => {
    session.setStatus({
      mode: "normal",
      table: "settings",
      hints: testing
        ? [`testing ${testing}…`, "Esc cancel"]
        : form
          ? form.kind === "connection"
            ? [field === "filename" ? `type filename${completions.length > 0 ? " · Tab completes" : ""}` : `type ${(field && FIELD_LABEL[field]) ?? "value"}`, "Tab field", "Enter save", "Esc cancel"]
            : ["type name", "Tab engine", "Enter save", "Esc cancel"]
          : ["e explorer", "j/k move", "Enter expand", "a add", "d delete", "t test", "? help"],
    })
  }, [session.setStatus, form, field, testing, completions.length])

  useKeyboard(e => {
    if (router.helpOpen || commandLine.open) return
    const key = e.name

    if (form) {
      if (key === "escape" || key === "Escape" || key === "\u001b") {
        cancelForm()
        return
      }
      if (key === "return" || key === "enter" || key === "\r") {
        submitForm()
        return
      }
      if (key === "tab") {
        tab()
        return
      }
      if (key === "backspace") {
        backspace()
        return
      }
      if (key === " " || key === "space") {
        typeChar(" ")
        return
      }
      if (key && key.length === 1) {
        typeChar(key)
        return
      }
      return
    }

    switch (key) {
      case "e":
        router.setScreen("explorer")
        return
      case "j":
        move(1)
        return
      case "k":
        move(-1)
        return
      case "g":
      case "G":
        jump(key === "G" ? "last" : "first")
        return
      case "enter":
      case "return":
      case "\r":
        toggle()
        return
      case "a":
        add()
        return
      case "d":
        remove()
        return
      case "t":
        testConnection()
        return
    }
  })

  return (
    <box flexGrow={1} flexDirection="column" borderStyle="rounded" borderColor={c.border} marginX={1}>
      <box paddingX={1}>
        <text fg={c.textBright}>SETTINGS</text>
        <text fg={c.textMuted}> · projects / databases / connections</text>
      </box>

      <box flexGrow={1} flexDirection="column" paddingX={1} overflow="hidden">
        {items.length === 0 ? (
          <text fg={c.textMuted}>no projects yet — press a to add one</text>
        ) : (
          items.map((item, index) => (
            <SettingsRow key={item.id} item={item} index={index} cursor={cursor} />
          ))
        )}
      </box>

      <box height={1} flexDirection="row" paddingX={1} overflow="hidden">
        {testing ? (
          <text fg={c.info}>
            testing connection {testing} …
          </text>
        ) : form ? (
          form.kind === "connection" ? (
            <box flexDirection="row">
              <text fg={c.info}>new connection · </text>
              {field ? (
                <>
                  <text fg={c.textMuted}>{FIELD_LABEL[field]}:</text>
                  <text fg={c.textBright}>{draft}</text>
                  <text fg={c.accent}>▍</text>
                </>
              ) : null}
              <box flexGrow={1} />
              <text fg={c.textMuted}>
                field {fieldIndex + 1}/{fieldCount} · Tab {field === "filename" ? "complete" : "field"} · Enter save
              </text>
            </box>
          ) : (
            <box flexDirection="row">
              <text fg={c.info}>
                {form.kind === "database" ? `new database (${engine}):` : "new project:"}
              </text>
              <text fg={c.info}> </text>
              <text fg={c.textBright}>{draft}</text>
              <text fg={c.accent}>▍</text>
              {form.kind === "database" ? <text fg={c.info}>  tab cycles engine</text> : null}
            </box>
          )
        ) : (
          <text fg={c.textMuted}>
            e explorer · j/k move · Enter expand · a add · d delete · t test · ? help
          </text>
        )}
      </box>

      {/* Filesystem matches for the sqlite filename field, on their own row so
          they never crowd the form's status line. */}
      {form?.kind === "connection" && field === "filename" && draft.length > 0 && completions.length > 0 ? (
        <box height={1} paddingX={1} overflow="hidden">
          <text fg={c.textMuted} truncate>
            {completions.slice(0, 8).join("  ")}
            {completions.length > 8 ? "  …" : ""}
          </text>
        </box>
      ) : null}
    </box>
  )
}

function SettingsRow({ item, index, cursor }: { item: SettingsListItem; index: number; cursor: number }) {
  const theme = useTheme()
  const c = theme.colors
  const selected = index === cursor
  const fg = selected ? c.textBright : c.text
  const bg = selected ? c.bgHighlight : undefined
  const indent = "  ".repeat(item.depth)

  const glyph =
    item.kind === "connection" ? "• " : item.expanded ? "▾ " : "▸ "

  return (
    <box height={1} flexDirection="row" backgroundColor={bg} paddingX={1}>
      <text fg={fg}>
        {indent}
        {glyph}
        {item.label}
        {item.meta ? ` <${item.meta}>` : ""}
      </text>
    </box>
  )
}