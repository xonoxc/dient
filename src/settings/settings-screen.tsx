/**
 * Settings screen. Renders the config tree (projects → databases) and drives
 * the keyboard forms: `a` opens a single-line connection prompt (paste a
 * `postgres://` / `mysql://` URL or a SQLite path; the tail becomes the name),
 * same style of prompt for a new project (`p` selects it), `u` flips to a
 * credentials form, `r` renames a database, `t` pings it with
 * retry, `d` deletes. Focus lives entirely here while this screen is active.
 */
import { useEffect } from "react"
import { useKeyboard } from "@opentui/react"
import { useTheme } from "@/theme-context"
import { useRouter, useCommandLine, useSessionStatus } from "@/app-context"
import { useSettings, type SettingsForm, type SettingsListItem } from "@/settings/use-settings"
import { FIELD_LABEL, CONNECTION_FIELDS } from "@/settings/use-settings"

export function SettingsScreen() {
  const theme = useTheme()
  const c = theme.colors
  const router = useRouter()
  const commandLine = useCommandLine()
  const session = useSessionStatus()
  const settings = useSettings()

  const {
    items,
    cursor,
    form,
    draft,
    field,
    fieldCount,
    move,
    jump,
    toggle,
    add,
    addProject,
    remove,
    rename,
    testConnection,
    submitForm,
    cancelForm,
    tab,
    cycleEngine,
    typeChar,
    backspace,
    testing,
    completions,
  } = settings

  const fieldLabel = field ? (field === "uri" ? "connection string" : (FIELD_LABEL[field as keyof typeof FIELD_LABEL] ?? "value")) : ""

  useEffect(() => {
    session.setStatus({
      mode: "normal",
      table: "settings",
      hints: testing
        ? [`testing ${testing}…`, "Esc cancel"]
        : form
          ? form.kind === "connect" && form.mode === "uri"
            ? ["paste connection string", "Tab complete", "u credentials", "Enter add", "Esc cancel"]
            : form.kind === "connect"
              ? [`type ${fieldLabel}`, "Tab field", "e engine", "u uri", "Enter add", "Esc cancel"]
              : form.kind === "connectName"
                ? ["database name missing", "Enter add", "Esc cancel"]
                : form.kind === "rename"
                  ? ["new name", "Enter save", "Esc cancel"]
                  : ["type name", "Enter save", "Esc cancel"]
          : ["a db", "p project", "e explorer", "j/k move", "Enter expand", "r rename", "t test", "d delete", "? help"],
    })
  }, [session.setStatus, form, field, testing, completions.length]) // eslint-disable-line react-hooks/exhaustive-deps

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
      if (key === "u" && form.kind === "connect") {
        cycleEngine()
        return
      }
      if (key === "e" && form.kind === "connect" && form.mode !== "uri") {
        cycleEngine()
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
      case "p":
        addProject()
        return
      case "r":
        rename()
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
        <text fg={c.textMuted}> · projects / databases</text>
      </box>

      <box flexGrow={1} flexDirection="column" paddingX={1} overflow="hidden">
        {items.length === 0 ? (
          <text fg={c.textMuted}>no projects yet — press a to add one</text>
        ) : (
          items.map((item, index) => (
            <SettingsRow key={item.id} item={item} index={index} cursor={cursor} testing={testing} />
          ))
        )}
      </box>

      <FormStatus
        form={form}
        field={field}
        fieldLabel={fieldLabel}
        fieldCount={fieldCount}
        draft={draft}
        testing={testing}
        completions={completions}
      />

      {/* Filesystem matches for a SQLite path, on their own row so they never
          crowd the form's status line. */}
      {form?.kind === "connect" && draft.length > 0 && completions.length > 0 ? (
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

function FormStatus({
  form,
  field,
  fieldLabel,
  fieldCount,
  draft,
  testing,
  completions,
}: {
  form: SettingsForm | null
  field: string | null
  fieldLabel: string
  fieldCount: number
  draft: string
  testing: string | null
  completions: ReadonlyArray<string>
}) {
  const theme = useTheme()
  const c = theme.colors

  if (testing) {
    return (
      <box height={1} flexDirection="row" paddingX={1} overflow="hidden">
        <text fg={c.info}>testing connection {testing} …</text>
        <box flexGrow={1} />
        <text fg={c.textMuted}>retrying up to 3x · t again to re-test</text>
      </box>
    )
  }

  if (!form) {
    return (
      <box height={1} flexDirection="row" paddingX={1} overflow="hidden">
        <text fg={c.textMuted}>
          e explorer  j/k move  Enter  a db  A project  r rename  t test  d delete  ? help
        </text>
      </box>
    )
  }

  if (form.kind === "connect") {
    const prompt = form.mode === "uri" ? "connection string: " : `${fieldLabel}: `
    return (
      <box height={1} flexDirection="row" paddingX={1} overflow="hidden">
        <text fg={c.info}>new database · </text>
        <text fg={c.textMuted}>{prompt}</text>
        <text fg={c.textBright}>{draft}</text>
        <text fg={c.accent}>▍</text>
        <box flexGrow={1} />
        {form.mode === "fields" ? (
          <text fg={c.textMuted}>
            {completions.length > 0 ? "Tab complete · " : ""}field {field === "name" ? 1 : 2}/{fieldCount} · e engine ·
            Enter add
          </text>
        ) : null}
      </box>
    )
  }

  if (form.kind === "connectName") {
    return (
      <box height={1} flexDirection="row" paddingX={1} overflow="hidden">
        <text fg={c.info}>the URL has no database name · name: </text>
        <text fg={c.textBright}>{draft}</text>
        <text fg={c.accent}>▍</text>
      </box>
    )
  }

  const prompt = form.kind === "rename" ? "rename to: " : "new project: "
  return (
    <box height={1} flexDirection="row" paddingX={1} overflow="hidden">
      <text fg={c.info}>{prompt}</text>
      <text fg={c.textBright}>{draft}</text>
      <text fg={c.accent}>▍</text>
    </box>
  )
}

function SettingsRow({
  item,
  index,
  cursor,
  testing,
}: {
  item: SettingsListItem
  index: number
  cursor: number
  testing: string | null
}) {
  const theme = useTheme()
  const c = theme.colors
  const selected = index === cursor
  const fg = selected ? c.textBright : c.text
  const bg = selected ? c.bgHighlight : undefined
  const indent = "  ".repeat(item.depth)

  const glyph = item.kind === "project" ? (item.expanded ? "▾ " : "▸ ") : "○ "
  const conn = item.connection

  const summary = conn
    ? conn.filename
      ? ` · ${conn.filename}`
      : ` · ${conn.user ? `${conn.user}@` : ""}${conn.host ?? "localhost"}${conn.port ? `:${conn.port}` : ""}`
    : " · no connection"

  return (
    <box height={1} flexDirection="row" backgroundColor={bg} paddingX={1}>
      <text fg={fg}>
        {indent}
        {glyph}
        {item.label}
        {item.meta ? ` <${item.meta}>` : ""}
      </text>
      <box flexGrow={1} />
      <text fg={conn ? c.textMuted : c.warning}>{summary}</text>
      {testing && selected ? <text fg={c.info}> … testing</text> : null}
    </box>
  )
}
