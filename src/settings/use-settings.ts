/**
 * Settings screen state. Renders the config tree (projects → databases) and
 * drives keyboard forms.
 *
 * The model is deliberately flat: a database *is* its connection. Pressing `a`
 * opens a single-line prompt where you paste a connection string — a
 * `postgres://` / `mysql://` URL or a filesystem path (SQLite). `p` opens the
 * same style of prompt for a new project (a project is a folder onto which
 * databases hang). The tail of
 * the string becomes the database's display name, so adding a database is one
 * paste. A credentials form (host/port/user/…) is one key away for people who
 * prefer filling fields (Ctrl+n), and when a server URL carries no database
 * name the form asks for it in a follow-up prompt.
 *
 * Form state is mirrored into refs: keyboard handlers fire between React
 * commits when a user (or a test pressing whole chords) types faster than a
 * frame, so every action reads the live value instead of a stale render
 * closure — the same trick the shell's command line and the cell editor use.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { Effect } from "effect"
import { useConfigRevision, useDialog, useServices, useToasts } from "@/app-context"
import { completePath, pathCandidates } from "@/fs/path-complete"
import { parseConnectionString, type ConnectionString } from "@/connection/parse"
import type { CreateConnectionInput } from "@/config"
import type { Connection, ConnectionId, Database, DatabaseId, Engine, Project, ProjectId } from "@/domain"

export type SettingsKind = "project" | "database"

export interface SettingsListItem {
  readonly id: string
  readonly kind: SettingsKind
  readonly refId: string
  readonly parentId: string | null
  readonly label: string
  readonly meta: string | null
  readonly depth: number
  readonly expanded: boolean
  /** The database's connection params ride along on the row (may be absent). */
  readonly connection?: Connection | null
}

export type ConnectionFormField = "name" | "host" | "port" | "user" | "password" | "filename" | "defaultDatabase"

export type SettingsForm =
  | { readonly kind: "project" }
  /** First stop when adding a database: paste a URL, or fill in fields. Both
      styles every DB client offers; picking one up front beats hiding the
      field form behind a chord. */
  | { readonly kind: "addChoice"; readonly projectId: ProjectId; readonly cursor: number }
  | {
      readonly kind: "connect"
      readonly projectId: ProjectId
      readonly mode: "uri" | "fields"
      readonly fieldIndex: number
      readonly values: Partial<Record<ConnectionFormField | "uri", string>>
      /** Engine for the credentials ("fields") mode. */
      readonly engine: Engine
    }
  | {
      readonly kind: "connectName"
      readonly projectId: ProjectId
      /** The parsed server URL that was missing a database name. */
      readonly pending: Extract<ConnectionString, { engine: "postgres" | "mysql" }>
    }
  | { readonly kind: "rename"; readonly databaseId: DatabaseId }

export const CONNECTION_FIELDS: Record<Engine, readonly ConnectionFormField[]> = {
  sqlite: ["filename"],
  postgres: ["host", "port", "user", "password", "defaultDatabase"],
  mysql: ["host", "port", "user", "password", "defaultDatabase"],
}

export const FIELD_LABEL: Record<ConnectionFormField, string> = {
  name: "name",
  host: "host",
  port: "port",
  user: "user",
  password: "password",
  filename: "filename",
  defaultDatabase: "database",
}

export interface UseSettingsResult {
  readonly items: ReadonlyArray<SettingsListItem>
  /** Projects as loaded from the config store; the add menu names its target. */
  readonly projects: ReadonlyArray<Project>
  readonly cursor: number
  readonly form: SettingsForm | null
  /** Live accessor for the open form, so a key handler firing between React
      commits reads the current form and never a stale render closure. */
  readonly formNow: () => SettingsForm | null
  readonly draft: string
  readonly engine: Engine
  readonly field: string | null
  readonly fieldIndex: number
  readonly fieldCount: number
  readonly typeChar: (char: string) => void
  readonly backspace: () => void
  readonly setDraft: (draft: string) => void
  readonly tab: () => void
  /** In the connect form: `uri` ⇄ `fields`, then cycle the engine. */
  readonly cycleEngine: () => void
  readonly move: (delta: -1 | 1) => void
  readonly jump: (position: "first" | "last") => void
  readonly toggle: () => void
  readonly add: () => void
  /** Open the single-line prompt for creating a new project. */
  readonly addProject: () => void
  /** From the "add database" choice: paste a connection string. */
  readonly addByUri: (projectId: ProjectId) => void
  /** From the "add database" choice: type host / port / user / password. */
  readonly addByFields: (projectId: ProjectId) => void
  /** Move the highlight in the "add database" menu. */
  readonly addChoiceMove: (delta: number) => void
  /** Open the highlighted "add database" choice. */
  readonly addChoiceSubmit: () => void
  readonly remove: () => void
  readonly rename: () => void
  readonly testConnection: () => void
  readonly submitForm: () => void
  readonly cancelForm: () => void
  /** Non-null while a connection test is in flight (renders "testing …"). */
  readonly testing: string | null
  /** Filesystem matches for a SQLite filename / uri draft being typed. */
  readonly completions: ReadonlyArray<string>
}

/** A connection-string draft that currently reads as a filesystem path. */
const isPathLike = (draft: string): boolean => !/^[a-z][a-z0-9+.-]*:\/\//i.test(draft.trim())

export const buildSettingsTree = (
  projects: ReadonlyArray<Project>,
  databases: ReadonlyMap<ProjectId, ReadonlyArray<Database>>,
  connections: ReadonlyMap<DatabaseId, ReadonlyArray<Connection>>,
  expanded: ReadonlySet<string>
): ReadonlyArray<SettingsListItem> => {
  const items: SettingsListItem[] = []
  for (const project of projects) {
    const projectExpanded = expanded.has(project.id)
    items.push({
      id: `project:${project.id}`,
      kind: "project",
      refId: project.id,
      parentId: null,
      label: project.name,
      meta: null,
      depth: 0,
      expanded: projectExpanded,
    })
    if (!projectExpanded) continue
    for (const database of databases.get(project.id) ?? []) {
      const connection = (connections.get(database.id) ?? [])[0] ?? null
      items.push({
        id: `database:${database.id}`,
        kind: "database",
        refId: database.id,
        parentId: project.id,
        label: database.name,
        meta: database.engine,
        depth: 1,
        expanded: false,
        connection,
      })
    }
  }
  return items
}

/** The two add-database choices, in render order. Exported so the menu render
    and the key handler cannot drift apart. */
export const ADD_CHOICES = [
  { label: "paste connection string", hint: "mysql://user:pass@host:3306/db" },
  { label: "host / user / password", hint: "name, host, port, user, password, database" },
] as const

const ENGINES: ReadonlyArray<Engine> = ["postgres", "mysql", "sqlite"]

export const useSettings = (): UseSettingsResult => {
  const { configStore, connectionManager, errorLog } = useServices()
  const toasts = useToasts()
  const dialog = useDialog()
  const configRevision = useConfigRevision()

  const [projects, setProjects] = useState<ReadonlyArray<Project>>([])
  const [databases, setDatabases] = useState<ReadonlyMap<ProjectId, ReadonlyArray<Database>>>(new Map())
  const [connections, setConnections] = useState<ReadonlyMap<DatabaseId, ReadonlyArray<Connection>>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState(0)
  /* Set when a create succeeds; the next tree build parks the cursor on it. */
  const pendingRevealRef = useRef<{ readonly kind: "database"; readonly projectId: ProjectId; readonly name: string } | null>(
    null
  )
  const [form, setFormState] = useState<SettingsForm | null>(null)
  const [draft, setDraftState] = useState("")
  const [engine, setEngineState] = useState<Engine>("postgres")
  const [testing, setTesting] = useState<string | null>(null)
  const testingRef = useRef<string | null>(null)

  const formRef = useRef<SettingsForm | null>(null)
  const draftRef = useRef("")
  const engineRef = useRef<Engine>("postgres")

  /** The databases map is keyed by project; look a database up by its own id. */
  const databaseById = (id: DatabaseId): Database | undefined => {
    for (const projectDatabases of databases.values()) {
      const found = projectDatabases.find(database => database.id === id)
      if (found) return found
    }
    return undefined
  }

  const refresh = (): void => {
    const restore = (): void => {
      formRef.current = null
      draftRef.current = ""
      setFormState(null)
      setDraftState("")
    }
    void Effect.runPromise(configStore.listProjects())
      .then(async rows => {
        setProjects(rows)
        for (const project of rows) {
          const dbRows = (await Effect.runPromise(configStore.listDatabases(project.id)).catch(() => null)) ?? []
          setDatabases(current => {
            const next = new Map(current)
            next.set(project.id, dbRows)
            return next
          })
          for (const database of dbRows) {
            const connRows = (await Effect.runPromise(configStore.listConnections(database.id)).catch(() => null)) ?? []
            setConnections(current => {
              const next = new Map(current)
              next.set(database.id, connRows)
              return next
            })
          }
        }
      })
      .catch(() => setProjects([]))
      .finally(restore)
  }

  useEffect(refresh, [configStore])

  const items = useMemo(
    () => buildSettingsTree(projects, databases, connections, expanded),
    [projects, databases, connections, expanded]
  )

  /* Park the cursor on a row that was just created, once the tree contains it. */
  useEffect(() => {
    const pending = pendingRevealRef.current
    if (!pending) return
    const index = items.findIndex(
      item => item.kind === "database" && item.label === pending.name && item.parentId === pending.projectId
    )
    if (index < 0) return
    pendingRevealRef.current = null
    setCursor(index)
  }, [items])

  const clamp = (next: number): number => Math.max(0, Math.min(Math.max(items.length - 1, 0), next))

  /** Field order for the credentials form: an explicit name first, then the
      engine's own settings. */
  const fieldsOf = (form: Extract<SettingsForm, { kind: "connect" }>): readonly ConnectionFormField[] => [
    "name",
    ...CONNECTION_FIELDS[form.engine],
  ]

  const field = (() => {
    if (form?.kind !== "connect") return null
    if (form.mode === "uri") return "uri"
    return fieldsOf(form)[form.fieldIndex] ?? null
  })()
  const fieldCount = form?.kind === "connect" && form.mode === "fields" ? fieldsOf(form).length : 0
  const fieldIndex = form?.kind === "connect" ? form.fieldIndex : 0

  /* Live path matches for a SQLite path being typed (uri mode treats a bare
     draft as a file system path, so completion applies to both). */
  const completions = useMemo(() => {
    if (form?.kind !== "connect") return []
    const active = form.mode === "uri" ? "uri" : fieldsOf(form)[form.fieldIndex]
    if (active !== "uri" && active !== "filename") return []
    if (active === "uri" && !isPathLike(draft)) return []
    return pathCandidates(draft)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, draft, engine])

  /**
   * Make a freshly created row visible. A database is only listed under an
   * *expanded* project, so creating one under a collapsed project reported
   * "added" while showing nothing at all. Expanding the parent and moving the
   * cursor onto the new row is what makes the result confirm itself.
   */
  const revealDatabase = (projectId: ProjectId, name: string): void => {
    setExpanded(current => (current.has(projectId) ? current : new Set(current).add(projectId)))
    /* The tree is rebuilt from the next refresh, so land on the row by id once
       it exists rather than guessing an index. */
    pendingRevealRef.current = { kind: "database", projectId, name }
    /* Tell the explorer sidebar to expand this project too. */
    configRevision.bump(projectId)
  }

  const openForm = (next: SettingsForm | null): void => {
    formRef.current = next
    let buffer = ""
    if (next?.kind === "connect")
      buffer = next.values[next.mode === "uri" ? "uri" : (fieldsOf(next)[next.fieldIndex] ?? "name")] ?? ""
    else if (next?.kind === "rename") buffer = databaseById(next.databaseId)?.name ?? ""
    draftRef.current = buffer
    setFormState(next)
    setDraftState(buffer)
  }

  /** Open the single-line prompt for creating a new project. */
  const addProject = (): void => {
    openForm({ kind: "project" })
  }

  /** Add a database to `projectId` by pasting a connection string. */
  const addByUri = (projectId: ProjectId): void => {
    openForm({ kind: "connect", projectId, mode: "uri", fieldIndex: 0, values: {}, engine: "postgres" })
  }

  /** Add a database to `projectId` by filling in host / user / password, the
      way every other DB client does it. */
  const addByFields = (projectId: ProjectId): void => {
    openForm({ kind: "connect", projectId, mode: "fields", fieldIndex: 0, values: {}, engine: "postgres" })
  }

  /** The two add-database choices, in render order. Keeping them in one place
      means the menu, its keys, and Enter cannot drift apart. */
  const moveAddChoice = (delta: number): void => {
    const current = formRef.current
    if (current?.kind !== "addChoice") return
    openForm({
      ...current,
      cursor: Math.max(0, Math.min(ADD_CHOICES.length - 1, current.cursor + delta)),
    })
  }

  /** Enter on the add-database menu opens the highlighted choice. */
  const submitAddChoice = (): void => {
    const current = formRef.current
    if (current?.kind !== "addChoice") return
    if (current.cursor === 0) addByUri(current.projectId)
    else addByFields(current.projectId)
  }

  const typeChar = (char: string): void => {
    const current = formRef.current
    if (!current || current.kind !== "connect") {
      draftRef.current += char
      setDraftState(draftRef.current)
      return
    }
    const key = current.mode === "uri" ? "uri" : fieldsOf(current)[current.fieldIndex]
    if (!key) return
    const text = (current.values[key] ?? "") + char
    const next: SettingsForm = { ...current, values: { ...current.values, [key]: text } }
    formRef.current = next
    draftRef.current = text
    setFormState(next)
    setDraftState(text)
  }

  const backspace = (): void => {
    const current = formRef.current
    if (!current || current.kind !== "connect") {
      draftRef.current = draftRef.current.slice(0, -1)
      setDraftState(draftRef.current)
      return
    }
    const key = current.mode === "uri" ? "uri" : fieldsOf(current)[current.fieldIndex]
    if (!key) return
    const text = (current.values[key] ?? "").slice(0, -1)
    const next: SettingsForm = { ...current, values: { ...current.values, [key]: text } }
    formRef.current = next
    draftRef.current = text
    setFormState(next)
    setDraftState(text)
  }

  const createDatabaseAndConnection = (
    projectId: ProjectId,
    name: string,
    engine: Engine,
    params: Partial<Omit<CreateConnectionInput, "databaseId">>
  ): Promise<void> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* configStore.createDatabase({ projectId, name, engine })
        yield* configStore.createConnection({ databaseId: database.id, ...params })
      })
    ).then(() => {
      /* Every create path funnels through here, so reveal once, here. */
      revealDatabase(projectId, name)
    })

  const nameTaken = (projectId: ProjectId, name: string): Promise<boolean> =>
    Effect.runPromise(configStore.listDatabases(projectId)).then(rows => rows.some(row => row.name === name))

  const submitConnectionForm = (form: Extract<SettingsForm, { kind: "connect" }>): void => {
    const finish = (): void => {
      openForm(null)
      refresh()
    }

    if (form.mode === "uri") {
      const parsed = parseConnectionString(draftRef.current)
      if (!parsed) {
        toasts.push("error", "could not parse that connection string")
        return
      }
      if (parsed.engine === "sqlite") {
        void (async () => {
          if (await nameTaken(form.projectId, parsed.name)) {
            toasts.push("error", `a database named "${parsed.name}" already exists`)
            return
          }
          await createDatabaseAndConnection(form.projectId, parsed.name, "sqlite", { filename: parsed.filename })
          toasts.push("success", `added ${parsed.name} (${parsed.filename})`)
          finish()
        })().catch(cause => {
          errorLog.append("settings.addConnection", cause)
          toasts.push("error", `failed to add: ${String(cause)}`)
        })
        return
      }
      if (!parsed.name) {
        /* server URL with no database name — ask for it next */
        const next: SettingsForm = { kind: "connectName", projectId: form.projectId, pending: parsed }
        openForm(next)
        return
      }
      const urlName = parsed.name
      void (async () => {
        if (await nameTaken(form.projectId, urlName)) {
          toasts.push("error", `a database named "${urlName}" already exists`)
          return
        }
        await createDatabaseAndConnection(form.projectId, urlName, parsed.engine, {
          host: parsed.host,
          port: parsed.port,
          user: parsed.user,
          password: parsed.password,
          defaultDatabase: parsed.defaultDatabase ?? urlName,
        })
        toasts.push("success", `added ${urlName} (${parsed.engine})`)
        finish()
      })().catch(cause => {
        errorLog.append("settings.addConnection", cause)
        toasts.push("error", `failed to add: ${String(cause)}`)
      })
      return
    }

    /* Credentials ("fields") mode: explicit name first, then host/port/… */
    const values = form.values
    const name = values.name?.trim() ?? ""
    if (!name) {
      toasts.push("error", "a database name is required")
      return
    }
    if (form.engine === "sqlite") {
      const filename = values.filename?.trim() ?? ""
      if (!filename) {
        toasts.push("error", "a sqlite connection requires a filename")
        return
      }
      void (async () => {
        if (await nameTaken(form.projectId, name)) return toastTaken(name)
        await createDatabaseAndConnection(form.projectId, name, "sqlite", { filename })
        toasts.push("success", `added ${name} (${filename})`)
        finish()
      })().catch(cause => {
        errorLog.append("settings.addConnection", cause)
        toasts.push("error", `failed to add: ${String(cause)}`)
      })
      return
    }
    const host = values.host?.trim() ?? ""
    if (!host) {
      toasts.push("error", "a connection requires a host")
      return
    }
    const port = values.port?.trim() ?? ""
    if (port && !/^\d+$/.test(port)) {
      toasts.push("error", "port must be a number")
      return
    }
    void (async () => {
      if (await nameTaken(form.projectId, name)) return toastTaken(name)
      const input = {
        host,
        ...(port ? { port: Number(port) } : {}),
        ...(values.user?.trim() ? { user: values.user.trim() } : {}),
        ...(values.password?.trim() ? { password: values.password.trim() } : {}),
        ...(values.defaultDatabase?.trim() ? { defaultDatabase: values.defaultDatabase.trim() } : {}),
      }
      await createDatabaseAndConnection(form.projectId, name, form.engine, input)
      toasts.push("success", `added ${name} (${form.engine})`)
      finish()
    })().catch(cause => {
      errorLog.append("settings.addConnection", cause)
      toasts.push("error", `failed to add: ${String(cause)}`)
    })
  }

  const toastTaken = (name: string) => toasts.push("error", `a database named "${name}" already exists`)

  const submitFollowUpName = (form: Extract<SettingsForm, { kind: "connectName" }>): void => {
    const name = draftRef.current.trim()
    if (!name) {
      toasts.push("error", "a database name is required")
      return
    }
    const parsed = form.pending
    void (async () => {
      if (await nameTaken(form.projectId, name)) return toastTaken(name)
      await createDatabaseAndConnection(form.projectId, name, parsed.engine, {
        host: parsed.host,
        port: parsed.port,
        user: parsed.user,
        password: parsed.password,
        defaultDatabase: parsed.defaultDatabase ?? name,
      })
      toasts.push("success", `added ${name} (${parsed.engine})`)
      openForm(null)
      refresh()
    })().catch(cause => {
      errorLog.append("settings.addConnection", cause)
      toasts.push("error", `failed to add: ${String(cause)}`)
    })
  }

  const testConnection = (): void => {
    const item = items[Math.min(cursor, items.length - 1)]
    if (!item || item.kind !== "database") {
      toasts.push("info", "move to a database row (j/k) and press t to test it")
      return
    }
    if (testingRef.current) return
    const database = databaseById(item.refId as DatabaseId)
    const connection = item.connection ?? null
    if (!database) {
      toasts.push("error", "database not found")
      return
    }
    if (!connection) {
      toasts.push("error", `"${database.name}" has no connection — add one from settings`)
      return
    }
    const label = database.name
    testingRef.current = label
    setTesting(label)
    toasts.push("info", `testing ${label}…`)
    void Effect.runPromise(connectionManager.pingConnection(database, connection))
      .then(ok => {
        testingRef.current = null
        setTesting(null)
        if (ok) toasts.push("success", `${label} ok (${database.engine})`)
        else toasts.push("error", `${label} unreachable`)
      })
      .catch(cause => {
        testingRef.current = null
        setTesting(null)
        errorLog.append("settings.testConnection", cause)
        toasts.push("error", `${label} unreachable: ${String(cause)}`)
      })
  }

  return {
    items,
    projects,
    cursor,
    form,
    formNow: () => formRef.current,
    draft,
    engine,
    field,
    fieldIndex,
    fieldCount,
    typeChar,
    backspace,
    setDraft: (text: string) => {
      draftRef.current = text
      setDraftState(text)
    },
    cycleEngine: () => {
      const current = formRef.current
      if (!current || current.kind !== "connect") return
      if (current.mode === "uri") {
        const next: SettingsForm = { ...current, mode: "fields", fieldIndex: 0 }
        formRef.current = next
        setFormState(next)
        return
      }
      const nextEngine = ENGINES[(ENGINES.indexOf(current.engine) + 1) % ENGINES.length]!
      engineRef.current = nextEngine
      setEngineState(nextEngine)
      const next: SettingsForm = { ...current, engine: nextEngine, fieldIndex: 0 }
      formRef.current = next
      setFormState(next)
      const key = fieldsOf(next)[0]!
      draftRef.current = next.values[key] ?? ""
      setDraftState(draftRef.current)
    },
    tab: () => {
      const current = formRef.current
      if (!current) return
      if (current.kind === "connect") {
        if (current.mode === "uri") {
          /* a bare draft is a file path — shell-style path completion */
          if (isPathLike(draftRef.current)) {
            draftRef.current = completePath(draftRef.current)
            setDraftState(draftRef.current)
          }
          return
        }
        const fields = fieldsOf(current)
        const fieldIndexNext = (current.fieldIndex + 1) % fields.length
        const next: SettingsForm = { ...current, fieldIndex: fieldIndexNext }
        formRef.current = next
        draftRef.current = next.values[fields[fieldIndexNext] ?? "name"] ?? ""
        setFormState(next)
        setDraftState(draftRef.current)
      }
    },
    move: delta => setCursor(current => clamp(current + delta)),
    jump: position => setCursor(position === "last" ? clamp(items.length) : 0),
    toggle: () => {
      const item = items[Math.min(cursor, items.length - 1)]
      if (!item || item.kind !== "project") return
      setExpanded(current => {
        const next = new Set(current)
        if (next.has(item.refId)) next.delete(item.refId)
        else next.add(item.refId)
        return next
      })
    },
    add: () => {
      const item = items[Math.min(cursor, items.length - 1)]
      if (!item) {
        addProject()
        return
      }
      const projectId =
        item.kind === "project"
          ? (item.refId as ProjectId)
          : ((item.parentId ?? projects[0]?.id ?? null) as ProjectId | null)
      if (!projectId) {
        addProject()
        return
      }
      openForm({ kind: "addChoice", projectId, cursor: 0 })
    },
    addProject,
    addByUri,
    addByFields,
    addChoiceMove: moveAddChoice,
    addChoiceSubmit: submitAddChoice,
    remove: () => {
      const item = items[Math.min(cursor, items.length - 1)]
      if (!item) return
      if (item.kind === "database") {
        void dialog
          .confirm({
            title: `Delete database "${item.label}"?`,
            body: "This removes the database and its connection settings.",
            okLabel: "delete",
            danger: true,
          })
          .then(ok => {
            if (!ok) return
            void Effect.runPromise(configStore.deleteDatabase(item.refId as DatabaseId))
              .then(() => {
                toasts.push("success", "database deleted")
                refresh()
              })
              .catch(cause => {
                errorLog.append("settings.deleteDatabase", cause)
                toasts.push("error", `failed to delete: ${String(cause)}`)
              })
          })
        return
      }
      void Effect.runPromise(configStore.deleteProject(item.refId as ProjectId))
        .then(() => {
          toasts.push("success", "project deleted")
          refresh()
        })
        .catch(cause => {
          errorLog.append("settings.deleteProject", cause)
          toasts.push("error", `failed to delete: ${String(cause)}`)
        })
    },
    rename: () => {
      const item = items[Math.min(cursor, items.length - 1)]
      if (!item || item.kind !== "database") {
        toasts.push("info", "move to a database row (j/k) and press r to rename it")
        return
      }
      openForm({ kind: "rename", databaseId: item.refId as DatabaseId })
    },
    testConnection,
    submitForm: () => {
      const current = formRef.current
      if (!current) return
      if (current.kind === "connect") {
        submitConnectionForm(current)
        return
      }
      if (current.kind === "connectName") {
        submitFollowUpName(current)
        return
      }
      if (current.kind === "rename") {
        const name = draftRef.current.trim()
        if (!name) {
          toasts.push("error", "a name is required")
          return
        }
        void Effect.runPromise(configStore.updateDatabase(current.databaseId, { name }))
          .then(() => {
            toasts.push("success", `renamed to ${name}`)
            openForm(null)
            refresh()
          })
          .catch(cause => {
            errorLog.append("settings.rename", cause)
            toasts.push("error", `rename failed: ${String(cause)}`)
          })
        return
      }
      const name = draftRef.current.trim()
      if (!name) {
        toasts.push("error", "a name is required")
        return
      }
      void Effect.runPromise(configStore.createProject({ name }))
        .then(() => {
          toasts.push("success", "project added")
          openForm(null)
          refresh()
        })
        .catch(cause => {
          toasts.push("error", `failed to add project: ${String(cause)}`)
          openForm(null)
          refresh()
        })
    },
    cancelForm: () => openForm(null),
    testing,
    completions,
  }
}
