/**
 * Settings screen. Renders the config tree (projects → databases) and drives
 * the keyboard forms. NORMAL mode binds `a` (add a database), `p` (add a
 * project), `r` (rename), `t` (ping), `d` (delete), `e` (explorer), `j/k`,
 * `Enter`; a form switches the screen to INSERT mode, where every printable
 * key is typed text — a pasted `mysql://user:pw@host:3306/db` contains most
 * of NORMAL mode's letters — and the form's own commands live on Ctrl chords
 * (Ctrl+n flips the engine/credentials form, Ctrl+Esc cancels, Tab completes).
 * Focus lives entirely here while this screen is active.
 */
import { useEffect, useRef } from "react"
import { useKeyboard } from "@opentui/react"
import { useTheme } from "@/theme-context"
import { useRouter, useCommandLine, useSessionStatus, useTextInput, type RoutedKey } from "@/app-context"
import { useSettings, type SettingsForm, type SettingsListItem } from "@/settings/use-settings"
import { FIELD_LABEL, CONNECTION_FIELDS, ADD_CHOICES } from "@/settings/use-settings"
import { resolveTypedChar } from "@/ui/text-entry"

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
    addByUri,
    addByFields,
    addChoiceMove,
    addChoiceSubmit,
    projects,
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
    formNow,
  } = settings

  const textInput = useTextInput()

  const fieldLabel = field ? (field === "uri" ? "connection string" : (FIELD_LABEL[field as keyof typeof FIELD_LABEL] ?? "value")) : ""

  useEffect(() => {
    session.setStatus({
      /* Ownership decides the mode, not the local `form` value. */
      mode: textInput.active ? "insert" : "normal",
      table: "settings",
      hints: testing
        ? [`testing ${testing}…`]
        : form
          ? form.kind === "addChoice"
            ? ["j/k move", "Enter open", "Esc cancel"]
            : form.kind === "connect" && form.mode === "uri"
              ? ["paste connection string", "Tab complete", "Ctrl+n credentials", "Enter add", "Esc cancel"]
              : form.kind === "connect"
                ? [`type ${fieldLabel}`, "Tab field", "Ctrl+n engine", "Enter add", "Esc cancel"]
                : form.kind === "connectName"
                  ? ["database name missing", "Enter add", "Esc cancel"]
                  : form.kind === "rename"
                    ? ["new name", "Enter save", "Esc cancel"]
                    : ["type name", "Enter save", "Esc cancel"]
          : ["a db", "p project", "e explorer", "j/k move", "Enter expand", "r rename", "t test", "d delete", "? help"],
    })
  }, [session.setStatus, form, field, testing, completions.length, textInput.active]) // eslint-disable-line react-hooks/exhaustive-deps

  /* INSERT mode: while a form is open it is the sole keyboard owner. The app
     dispatcher routes every key here and never consults a NORMAL binding, so a
     connection string can contain `: ? / u e` — anything — and still arrive
     verbatim. The form's own commands therefore live on chords a connection
     string never contains (Ctrl+Enter / Ctrl+Escape / Ctrl+Tab). */
  const handleFormKey = (e: RoutedKey): boolean => {
    const current = formNow()
    if (current === null) return true
    const key = e.name

    /* The add-database chooser is a two-key menu, not a text field. */
    if (current.kind === "addChoice") {
      /* A menu, not a text field: arrows and j/k move a visible highlight and
         Enter opens it. 1/2 stay as shortcuts. Every key is swallowed, so
         nothing leaks through to a NORMAL binding. */
      if (key === "j" || key === "down") addChoiceMove(1)
      else if (key === "k" || key === "up") addChoiceMove(-1)
      else if (key === "return" || key === "enter" || key === "\r") addChoiceSubmit()
      else if (key === "1") addByUri(current.projectId)
      else if (key === "2") addByFields(current.projectId)
      else if (key === "escape" || key === "Escape" || key === "\u001b") cancelForm()
      return true
    }

    if (key === "return" || key === "enter" || key === "\r") {
      submitForm()
      return true
    }
    if (key === "escape" || key === "Escape" || key === "\u001b") {
      cancelForm()
      return true
    }
    if (key === "tab") {
      tab()
      return true
    }
    if (key === "backspace") {
      backspace()
      return true
    }
    /* Chords: a modified key is never text, so this is safe. */
    if (e.ctrl === true) {
      if (key === "n" && current.kind === "connect") cycleEngine()
      return true
    }
    const char = resolveTypedChar(e)
    if (char !== null) typeChar(char)
    return true
  }

  /* The claim installs a trampoline so it always runs the newest closure: a
     claim outlives the render that created it, and a fast typist can outrun a
     render. Same always-latest semantics the runtime's useEffectEvent gives a
     plain `useKeyboard` handler. */
  const liveFormKeyRef = useRef(handleFormKey)
  liveFormKeyRef.current = handleFormKey
  /* `claim` in a ref: the effect must key on the *form* alone. Depending on
     the provider object would re-run the claim whenever ownership depth
     changed, and release-then-claim would bounce the depth forever. */
  const claimRef = useRef(textInput.claim)
  claimRef.current = textInput.claim
  useEffect(() => {
    if (form === null) return
    return claimRef.current(e => liveFormKeyRef.current(e))
  }, [form])

  useKeyboard(e => {
    /* NORMAL mode only. `route` hands the key to the open form and says so;
       there is nothing to bind in that case. */
    if (textInput.route(e)) return
    if (router.helpOpen || commandLine.open) return
    const key = e.name

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
        projectName={form?.kind === "addChoice" ? (projects.find(p => p.id === form.projectId)?.name ?? "project") : ""}
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
  projectName,
}: {
  form: SettingsForm | null
  field: string | null
  fieldLabel: string
  fieldCount: number
  draft: string
  testing: string | null
  completions: ReadonlyArray<string>
  projectName: string
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
          e explorer  j/k move  Enter  a db  p project  r rename  t test  d delete  ? help
        </text>
      </box>
    )
  }

  if (form.kind === "addChoice") {
    return (
      <box height={4} flexDirection="column" paddingX={1} overflow="hidden">
        <box height={1} flexDirection="row" overflow="hidden">
          <text fg={c.info}>new database in {projectName}</text>
        </box>
        {ADD_CHOICES.map((choice, index) => {
          const active = index === form.cursor
          return (
            <box key={choice.label} height={1} flexDirection="row" overflow="hidden">
              <text fg={active ? c.accent : c.textMuted}>{active ? "▸ " : "  "}</text>
              <text fg={active ? c.textBright : c.textMuted}>{choice.label}</text>
              <text fg={c.textMuted}>  {choice.hint}</text>
            </box>
          )
        })}
        <box height={1} flexDirection="row" overflow="hidden">
          <text fg={c.textMuted}>j/k move · Enter open · 1/2 direct · Esc cancel</text>
        </box>
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
            {completions.length > 0 ? "Tab complete · " : ""}field {field === "name" ? 1 : 2}/{fieldCount} · Ctrl+n
            engine · Enter add
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
