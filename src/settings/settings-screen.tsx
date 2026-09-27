/**
 * Settings screen. Renders the config tree (projects → databases) and drives
 * the keyboard forms. NORMAL mode binds `a` (add database), `p` (paste a URI),
 * `P` (add project), `r` (rename), `t` (ping), `d` (delete), `e` (explorer), `j/k`,
 * `Enter`; a form switches the screen to INSERT mode, where every printable
 * key is typed text — a pasted `mysql://user:pw@host:3306/db` contains most
 * of NORMAL mode's letters. In the credentials form, Tab changes fields,
 * Ctrl+n changes engines, Ctrl+v pastes, and Esc cancels.
 * Focus lives entirely here while this screen is active.
 */
import { useEffect, useRef } from "react"
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/react"
import { decodePasteBytes } from "@opentui/core"
import { useTheme } from "@/theme-context"
import { useRouter, useCommandLine, useSessionStatus, useTextInput, useToasts, type RoutedKey } from "@/app-context"
import { useSettings, type SettingsForm, type SettingsListItem } from "@/settings/use-settings"
import { FIELD_LABEL, CONNECTION_FIELDS, ADD_CHOICES } from "@/settings/use-settings"
import { resolveTypedChar } from "@/ui/text-entry"
import { LoadingIndicator } from "@/ui/loading-indicator"
import { readSystemClipboard } from "@/ui/clipboard"
import { ModalSurface } from "@/ui/modal-surface"
import type { ProjectId } from "@/domain"

export function SettingsScreen() {
  const theme = useTheme()
  const c = theme.colors
  const router = useRouter()
  const commandLine = useCommandLine()
  const session = useSessionStatus()
  const toasts = useToasts()
  const settings = useSettings()
  const { width, height } = useTerminalDimensions()

  const {
    items,
    cursor,
    form,
    draft,
    field,
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
    pasteText,
  } = settings

  const textInput = useTextInput()
  const selectedItem = items[cursor]
  const showDetails = width >= 100
  const listWidth = Math.min(48, Math.floor(width * 0.38))

  const fieldLabel = field ? (field === "uri" ? "connection string" : (FIELD_LABEL[field as keyof typeof FIELD_LABEL] ?? "value")) : ""

  const pasteConnectionString = () => {
    const item = items[cursor]
    const projectId = item?.kind === "project" ? item.refId : item?.parentId ?? projects[0]?.id
    if (!projectId) {
      toasts.push("info", "create a project with P before adding a database")
      return
    }
    addByUri(projectId as ProjectId)
    void readSystemClipboard()
      .then(text => {
        const activeForm = formNow()
        if (!activeForm || activeForm.kind !== "connect" || activeForm.mode !== "uri") return
        if (text) pasteText(text)
        else toasts.push("info", "clipboard is empty or unavailable; paste the URI into the field")
      })
      .catch(() => {
        const activeForm = formNow()
        if (activeForm?.kind === "connect" && activeForm.mode === "uri") {
          toasts.push("warning", "could not read system clipboard; paste the URI into the field")
        }
      })
  }

  usePaste(event => {
    if (!form) return
    event.preventDefault()
    pasteText(decodePasteBytes(event.bytes))
  })

  useEffect(() => {
    session.setStatus({
      /* Ownership decides the mode, not the local `form` value. */
      mode: textInput.active ? "insert" : "normal",
      table: "settings",
      hints: form
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
          : ["a db", "p paste URI", "Shift+P project", "e explorer", "j/k move", "Enter expand", "? help"],
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
      else if (key === "v") {
        void readSystemClipboard()
          .then(text => {
            if (text && formNow()) pasteText(text)
            else if (!text) toasts.push("info", "clipboard is empty or unavailable")
          })
          .catch(() => toasts.push("warning", "could not read system clipboard"))
      }
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

    // OpenTUI backends differ: shifted letters may arrive as `P`, or as
    // `p` with the modifier set. Normalize the project binding explicitly.
    if ((key === "P" || (key === "p" && e.shift === true)) && !e.ctrl && !e.meta) {
      addProject()
      return
    }

    switch (key) {
      case "e":
        router.setScreen("explorer")
        return
      case "j":
      case "down":
        move(1)
        return
      case "k":
      case "up":
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
        pasteConnectionString()
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
    <box flexGrow={1} flexDirection="column" overflow="hidden">
      <box height={3} flexDirection="row" alignItems="center" paddingX={1}>
        <box flexDirection="column">
          <text fg={c.accent}>SETTINGS</text>
          <text fg={c.textMuted}>Projects and database connections</text>
        </box>
        <box flexGrow={1} />
        <text fg={c.textMuted}>{projects.length} project{projects.length === 1 ? "" : "s"}</text>
      </box>

      <box flexGrow={1} flexDirection="row" overflow="hidden">
        <box width={showDetails ? listWidth : "100%"} flexDirection="column" overflow="hidden">
          <box height={1} paddingX={1}>
            <text fg={c.textMuted}>WORKSPACES</text>
          </box>
          <box flexGrow={1} flexDirection="column" paddingX={1} paddingTop={1} overflow="hidden">
            {items.length === 0 ? (
              <box flexDirection="column">
                <text fg={c.textBright}>No workspaces yet</text>
                <text fg={c.textMuted}>Press Shift+P to create a project, then add a database.</text>
              </box>
            ) : (
              items.map((item, index) => (
                <SettingsRow
                  key={item.id}
                  item={item}
                  index={index}
                  cursor={cursor}
                  testing={testing}
                  showSummary={!showDetails}
                />
              ))
            )}
          </box>
        </box>

        {showDetails ? (
          <>
            <box width={1} height="100%">
              <text fg={c.border}>{"│\n".repeat(Math.max(1, height))}</text>
            </box>
            <SettingsDetails item={selectedItem} projectCount={projects.length} />
          </>
        ) : null}
      </box>

      <FormStatus testing={testing} />
      {form ? (
        <SettingsFormDialog
          form={form}
          field={field}
          draft={draft}
          completions={completions}
          projectName={form.kind === "addChoice" ? (projects.find(p => p.id === form.projectId)?.name ?? "project") : ""}
          terminalWidth={width}
          terminalHeight={height}
        />
      ) : null}
    </box>
  )
}

function SettingsDetails({ item, projectCount }: { item?: SettingsListItem; projectCount: number }) {
  const { colors: c } = useTheme()
  const connection = item?.connection
  const location = connection?.filename
    ? connection.filename
    : connection
      ? `${connection.user ? `${connection.user}@` : ""}${connection.host ?? "localhost"}${connection.port ? `:${connection.port}` : ""}`
      : null

  return (
    <box flexGrow={1} flexDirection="column" paddingX={3} paddingY={1} overflow="hidden">
      <text fg={c.textMuted}>SELECTION</text>
      {item ? (
        <>
          <box height={1} />
          <text fg={c.textBright}>{item.label}</text>
          <text fg={item.kind === "database" ? c.accent : c.textMuted}>
            {item.kind === "database" ? (item.meta ?? "database").toUpperCase() : "PROJECT"}
          </text>
          <box height={1} />
          {item.kind === "project" ? (
            <>
              <text fg={c.textMuted}>Project workspace</text>
              <text fg={c.textMuted}>Press Enter to view its databases.</text>
            </>
          ) : (
            <>
              <text fg={c.textMuted}>{connection ? "CONNECTION" : "CONNECTION MISSING"}</text>
              <text fg={connection ? c.text : c.warning}>{location ?? "Add connection details with a."}</text>
              {connection?.defaultDatabase ? <text fg={c.textMuted}>default database · {connection.defaultDatabase}</text> : null}
            </>
          )}
          <box height={2} />
          <text fg={c.textMuted}>{item.kind === "project" ? "Shift+P  create project" : "r  rename   d  remove"}</text>
          <text fg={c.textMuted}>{item.kind === "project" ? "a  add database   p  paste URI" : "t  test connection"}</text>
        </>
      ) : (
        <>
          <box height={1} />
          <text fg={c.textBright}>Your database workspaces</text>
          <box height={1} />
          <text fg={c.textMuted}>{projectCount === 0 ? "Create a project to get started." : "Select a project or database to see details."}</text>
          <text fg={c.textMuted}>Press ? for all keyboard shortcuts.</text>
        </>
      )}
    </box>
  )
}

function FormStatus({ testing }: { testing: string | null }) {
  const theme = useTheme()
  const c = theme.colors

  if (testing) {
    return (
      <box height={1} flexDirection="row" paddingX={1} overflow="hidden">
        <LoadingIndicator label={`testing connection ${testing}…`} />
      </box>
    )
  }

  return null
}

function SettingsFormDialog({
  form,
  field,
  draft,
  completions,
  projectName,
  terminalWidth,
  terminalHeight,
}: {
  form: SettingsForm
  field: string | null
  draft: string
  completions: ReadonlyArray<string>
  projectName: string
  terminalWidth: number
  terminalHeight: number
}) {
  const { colors: c } = useTheme()
  const panelWidth = form.kind === "addChoice"
    ? Math.max(36, Math.min(62, terminalWidth - 4))
    : Math.max(40, Math.min(76, terminalWidth - 4))
  const title = form.kind === "addChoice" ? `Add database · ${projectName}`
    : form.kind === "connect" ? `Add database · ${form.mode === "uri" ? "connection string" : form.engine}`
      : form.kind === "connectName" ? "Choose a database name"
        : form.kind === "rename" ? "Rename database" : "New project"

  return (
    <box position="absolute" width="100%" height="100%" alignItems="center" justifyContent="center" backgroundColor={c.bg}>
      <ModalSurface width={panelWidth} paddingX={2} paddingY={1} maxHeight={Math.max(10, terminalHeight - 2)}>
        <text fg={c.accent}>{title}</text>
        <box height={1} />
        {form.kind === "addChoice" ? (
          <>
            <text fg={c.text}>Choose a connection method</text>
            <box height={1} />
            {ADD_CHOICES.map((choice, index) => {
              const selected = form.cursor === index
              return (
                <box key={choice.label} flexDirection="column">
                  <box height={1} flexDirection="row" alignItems="center" backgroundColor={selected ? c.bgHighlight : undefined} paddingX={1}>
                    <text fg={selected ? c.accent : c.textMuted}>{selected ? "›" : " "}</text>
                    <text fg={selected ? c.textBright : c.text} paddingLeft={1}>{choice.label}</text>
                  </box>
                  <box height={1} paddingLeft={3}>
                    <text fg={c.textMuted}>{choice.hint}</text>
                  </box>
                </box>
              )
            })}
            <box height={1} />
            <text fg={c.text}>↑/↓ or j/k move   Enter open   Esc cancel</text>
          </>
        ) : form.kind === "connect" && form.mode === "fields" ? (
          <CredentialsFields form={form} field={field} draft={draft} />
        ) : (
          <>
            <box height={1} flexDirection="row" backgroundColor={c.bgHighlight} paddingX={1}>
              <text fg={c.info}>
                {form.kind === "connect" ? "new database · connection string: "
                  : form.kind === "connectName" ? "the URL has no database name · name: "
                    : form.kind === "rename" ? "rename to: " : "new project: "}
              </text>
              <text fg={c.textBright} truncate>{draft || " "}</text>
              <text fg={c.accent}>▍</text>
            </box>
            {form.kind === "connect" && form.mode === "uri" ? (
              <>
                <box height={1} />
                <text fg={c.textMuted}>Ctrl+V paste · Enter add</text>
                {draft.length > 0 && completions.length > 0 ? <text fg={c.textMuted} truncate>{completions.slice(0, 5).join("  ")}</text> : null}
              </>
            ) : null}
          </>
        )}
        {form.kind !== "addChoice" ? (
          <>
            <box height={1} />
            <text fg={c.textMuted}>
              {form.kind === "connect" && form.mode === "fields"
                ? "Tab next field · Ctrl+n engine · Enter save · Esc cancel"
                : form.kind === "connect" && form.mode === "uri"
                  ? "Ctrl+V paste · Ctrl+N credentials · Enter add · Esc cancel"
                : "Enter save · Esc cancel"}
            </text>
          </>
        ) : null}
      </ModalSurface>
    </box>
  )
}

function CredentialsFields({
  form,
  field,
  draft,
}: {
  form: Extract<SettingsForm, { kind: "connect" }>
  field: string | null
  draft: string
}) {
  const { colors: c } = useTheme()
  const fields = ["name", ...CONNECTION_FIELDS[form.engine]]
  return (
    <box flexDirection="column">
      {fields.map(key => {
        const active = key === field
        const value = active ? draft : (form.values[key as keyof typeof form.values] ?? "")
        const display = key === "password" && value ? "•".repeat(Math.min(value.length, 32)) : value || (active ? " " : "—")
        const label = key === "defaultDatabase" ? "database" : (FIELD_LABEL[key as keyof typeof FIELD_LABEL] ?? key)
        return (
          <box key={key} height={1} flexDirection="row" backgroundColor={active ? c.bgHighlight : undefined} paddingX={1}>
            <text fg={active ? c.accent : c.textMuted} width={16}>{active ? "› " : "  "}{label}</text>
            <text fg={active ? c.textBright : c.text} truncate>{display}</text>
            {active ? <text fg={c.accent}>▍</text> : null}
          </box>
        )
      })}
    </box>
  )
}

function SettingsRow({
  item,
  index,
  cursor,
  testing,
  showSummary,
}: {
  item: SettingsListItem
  index: number
  cursor: number
  testing: string | null
  showSummary: boolean
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
      {showSummary ? <text fg={conn ? c.textMuted : c.warning}>{summary}</text> : null}
      {testing && selected ? <text fg={c.info}> … testing</text> : null}
    </box>
  )
}
