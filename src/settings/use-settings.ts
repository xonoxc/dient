/**
 * Settings screen state. Renders the config tree (projects → databases) and
 * drives keyboard forms.
 *
 * The model is deliberately flat: a database *is* its connection. Pressing `a`
 * opens a single-line prompt where you paste a connection string — a
 * `postgres://` / `mysql://` / `redis://` URL or a filesystem path (SQLite).
 * `p` opens the same style of prompt for a new project (a project is a folder
 * onto which databases hang). A parsed URI pauses on an optional name prompt:
 * the tail (or Redis host:port/index) is suggested, and a typed value overrides
 * it. A credentials form (host/port/user/…) is one key away for people who
 * prefer filling fields (Ctrl+n); its name field is optional and falls back to
 * the database/file stem or host:port.
 *
 * Form state is mirrored into refs: keyboard handlers fire between React
 * commits when a user (or a test pressing whole chords) types faster than a
 * frame, so every action reads the live value instead of a stale render
 * closure — the same trick the shell's command line uses.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { basename, extname } from "node:path"
import { Effect } from "effect"
import { useConfigRevision, useDialog, useServices, useToasts } from "@/app-context"
import { completePath, pathCandidates } from "@/fs/path-complete"
import { parseConnectionString, type ConnectionString } from "@/connection/parse"
import { describeError } from "@/errors/describe"

import type { CreateConnectionInput } from "@/config"
import type { ConfigError } from "@/config"
import type { Connection, Database, DatabaseId, Engine, Project, ProjectId } from "@/domain"

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
      /** A parsed URL whose display name can still be changed before saving. */
      readonly pending: ConnectionString
      /** The parsed name: URL tail, SQLite stem, or host:port/index for Redis. */
      readonly suggestedName?: string
    }
  | { readonly kind: "rename"; readonly databaseId: DatabaseId }

export const CONNECTION_FIELDS: Record<Engine, readonly ConnectionFormField[]> = {
  sqlite: ["filename"],
  postgres: ["host", "port", "user", "password", "defaultDatabase"],
  mysql: ["host", "port", "user", "password", "defaultDatabase"],
  redis: ["host", "port", "user", "password", "defaultDatabase"],
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

const ENGINE_DEFAULT_PORT: Record<Exclude<Engine, "sqlite">, string> = {
  postgres: "5432",
  mysql: "3306",
  redis: "6379",
}

const filenameStem = (filename: string): string => {
  const base = basename(filename.trim())
  return base.slice(0, Math.max(0, base.length - extname(base).length)) || base
}

/** A display name when the optional name field is blank. SQL uses its database
 *  stem, SQLite the file stem, and Redis host:port plus a non-zero index. */
export const fallbackConnectionName = (
  engine: Engine,
  values: Readonly<Partial<Record<ConnectionFormField | "uri", string>>>
): string => {
  const host = values.host?.trim() || "localhost"
  const port = values.port?.trim() || (engine === "sqlite" ? "" : ENGINE_DEFAULT_PORT[engine])
  const database = values.defaultDatabase?.trim()
  if (engine === "sqlite") return filenameStem(values.filename ?? "")
  if (engine === "redis") return `${host}:${port}${database && database !== "0" ? `/${database}` : ""}`
  return database || `${host}:${port}`
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
  readonly pasteText: (text: string) => void
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
  { label: "paste connection string", hint: "postgres://…  mysql://…  redis://…" },
  { label: "host / user / password", hint: "name, host, port, user, password, database" },
] as const

const ENGINES: ReadonlyArray<Engine> = ["postgres", "mysql", "sqlite", "redis"]

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
  const pendingRevealRef = useRef<{
    readonly kind: "database"
    readonly projectId: ProjectId
    readonly name: string
  } | null>(null)
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
      if (found) {
        return found
      }
    }
    return undefined
  }

  /* One add-flow failure handler, shared by every submit path below: log it
     for the error file, say it once in a toast. A small Effect composed into
     each program's `catchAll`, not five copies of a `.catch` callback. */
  const reportAddFailure = (op: string) => (cause: unknown) =>
    Effect.sync(() => {
      errorLog.append(op, cause)
      toasts.push("error", `failed to add: ${describeError(cause)}`)
    })

  const refresh = (): void => {
    const restore = (): void => {
      formRef.current = null
      draftRef.current = ""
      setFormState(null)
      setDraftState("")
    }

    /* One program: projects, then each project's databases, then each
       database's connections — committed level by level so the tree fills in
       as loads land, exactly like the old chained version. Every level folds
       to empty on failure; `restore` rides along in `ensuring` so it runs on
       every exit path, the way `.finally` did. */
    Effect.runFork(
      Effect.gen(function* () {
        const rows = yield* configStore.listProjects().pipe(Effect.orElseSucceed(() => []))
        yield* Effect.sync(() => setProjects(rows))
        yield* Effect.all(
          rows.map(project =>
            Effect.gen(function* () {
              const dbRows = yield* configStore.listDatabases(project.id).pipe(Effect.orElseSucceed(() => []))
              yield* Effect.sync(() =>
                setDatabases(current => {
                  const next = new Map(current)
                  next.set(project.id, dbRows)
                  return next
                })
              )
              const conns = yield* Effect.all(
                dbRows.map(database =>
                  Effect.map(
                    Effect.orElseSucceed(configStore.listConnections(database.id), () => []),
                    rows => ({ id: database.id, rows }) as const
                  )
                ),
                { concurrency: "unbounded" }
              )
              yield* Effect.sync(() =>
                setConnections(current => {
                  const next = new Map(current)
                  for (const { id, rows } of conns) next.set(id, rows)
                  return next
                })
              )
            })
          ),
          { concurrency: "unbounded" }
        )
      }).pipe(
        Effect.ensuring(Effect.sync(restore)),
        Effect.catchAll(() =>
          Effect.sync(() => {
            setProjects([])
          })
        )
      )
    )
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
    const next: SettingsForm = {
      ...current,
      values: { ...current.values, [key]: text },
    }

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
    const next: SettingsForm = {
      ...current,
      values: { ...current.values, [key]: text },
    }

    formRef.current = next
    draftRef.current = text
    setFormState(next)
    setDraftState(text)
  }

  /* Every create path funnels through here. Returns the Effect (rather than
     running it) so each submitter composes it into its own program — one
     fork per submit, with `revealDatabase` as the final stage. */
  const createDatabaseAndConnection = (
    projectId: ProjectId,
    name: string,
    engine: Engine,
    params: Partial<Omit<CreateConnectionInput, "databaseId">>
  ): Effect.Effect<void, ConfigError> =>
    Effect.gen(function* () {
      const database = yield* configStore.createDatabase({ projectId, name, engine })
      yield* configStore.createConnection({ databaseId: database.id, ...params })
      yield* Effect.sync(() => revealDatabase(projectId, name))
    })

  const nameTaken = (projectId: ProjectId, name: string): Effect.Effect<boolean, ConfigError> =>
    Effect.map(configStore.listDatabases(projectId), rows => rows.some(row => row.name === name))

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
      /* Every URI gets an optional naming step. The parsed tail (or Redis
         host:port/index) is the suggestion; a typed name overrides it. */
      const next: SettingsForm = {
        kind: "connectName",
        projectId: form.projectId,
        pending: parsed,
        suggestedName: parsed.name,
      }
      openForm(next)
      return
    }

    /* Credentials ("fields") mode: the name is optional. A blank name falls
       back to the database stem, SQLite file stem, or Redis host:port/index. */
    const values = form.values
    const explicitName = values.name?.trim() ?? ""

    if (form.engine === "sqlite") {
      const filename = values.filename?.trim() ?? ""
      if (!filename) {
        toasts.push("error", "a sqlite connection requires a filename")
        return
      }
      const name = explicitName || fallbackConnectionName("sqlite", values)
      if (!name) {
        toasts.push("error", "a database name is required")
        return
      }

      Effect.runFork(
        Effect.gen(function* () {
          if (yield* nameTaken(form.projectId, name)) {
            toastTaken(name)
            return
          }
          yield* createDatabaseAndConnection(form.projectId, name, "sqlite", { filename })
          toasts.push("success", `added ${name} (${filename})`)
          finish()
        }).pipe(Effect.catchAll(reportAddFailure("settings.addConnection")))
      )
      return
    }

    if (form.engine === "redis") {
      const host = values.host?.trim() ?? ""
      if (!host) {
        toasts.push("error", "a Redis connection requires a host")
        return
      }
      const port = values.port?.trim() ?? ""
      if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
        toasts.push("error", "port must be a number between 1 and 65535")
        return
      }
      const db = values.defaultDatabase?.trim() ?? "0"
      if (!/^\d+$/.test(db)) {
        toasts.push("error", "Redis database must be a numeric index")
        return
      }
      const name = explicitName || fallbackConnectionName("redis", values)

      Effect.runFork(
        Effect.gen(function* () {
          if (yield* nameTaken(form.projectId, name)) {
            toastTaken(name)
            return
          }
          yield* createDatabaseAndConnection(form.projectId, name, "redis", {
            host,
            ...(port ? { port: Number(port) } : {}),
            ...(values.user?.trim() ? { user: values.user.trim() } : {}),
            ...(values.password?.trim() ? { password: values.password.trim() } : {}),
            defaultDatabase: db,
          })
          toasts.push("success", `added ${name} (redis)`)
          finish()
        }).pipe(Effect.catchAll(reportAddFailure("settings.addConnection")))
      )
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
    const name = explicitName || fallbackConnectionName(form.engine, values)

    Effect.runFork(
      Effect.gen(function* () {
        if (yield* nameTaken(form.projectId, name)) {
          toastTaken(name)
          return
        }
        const input = {
          host,
          ...(port ? { port: Number(port) } : {}),
          ...(values.user?.trim() ? { user: values.user.trim() } : {}),
          ...(values.password?.trim() ? { password: values.password.trim() } : {}),
          ...(values.defaultDatabase?.trim() ? { defaultDatabase: values.defaultDatabase.trim() } : {}),
        }
        yield* createDatabaseAndConnection(form.projectId, name, form.engine, input)
        toasts.push("success", `added ${name} (${form.engine})`)
        finish()
      }).pipe(Effect.catchAll(reportAddFailure("settings.addConnection")))
    )
  }

  const toastTaken = (name: string) => toasts.push("error", `a database named "${name}" already exists`)

  const submitFollowUpName = (form: Extract<SettingsForm, { kind: "connectName" }>): void => {
    const typed = draftRef.current.trim()
    const name = typed || form.suggestedName || ""
    if (!name) {
      toasts.push("error", "a database name is required")
      return
    }
    const parsed = form.pending
    const input =
      parsed.engine === "sqlite"
        ? { filename: parsed.filename }
        : parsed.engine === "redis"
          ? {
              host: parsed.host,
              port: parsed.port,
              user: parsed.user,
              password: parsed.password,
              defaultDatabase: parsed.defaultDatabase ?? "0",
              ...(parsed.tls ? { tls: true } : {}),
            }
          : {
              host: parsed.host,
              port: parsed.port,
              user: parsed.user,
              password: parsed.password,
              defaultDatabase: parsed.defaultDatabase ?? name,
            }
    Effect.runFork(
      Effect.gen(function* () {
        if (yield* nameTaken(form.projectId, name)) {
          toastTaken(name)
          return
        }
        yield* createDatabaseAndConnection(form.projectId, name, parsed.engine, input)
        toasts.push(
          "success",
          parsed.engine === "sqlite" ? `added ${name} (${parsed.filename})` : `added ${name} (${parsed.engine})`
        )
        openForm(null)
        refresh()
      }).pipe(Effect.catchAll(reportAddFailure("settings.addConnection")))
    )
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

    Effect.runFork(
      Effect.gen(function* () {
        const ok = yield* connectionManager.pingConnection(database, connection)
        testingRef.current = null
        setTesting(null)
        if (ok) toasts.push("success", `${label} ok (${database.engine})`)
        else toasts.push("error", `${label} unreachable`)
      }).pipe(
        Effect.catchAll(cause =>
          Effect.sync(() => {
            testingRef.current = null
            setTesting(null)
            errorLog.append("settings.testConnection", cause)
            toasts.push("error", `${label} unreachable: ${describeError(cause)}`)
          })
        )
      )
    )
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
    pasteText: (text: string) => {
      const current = formRef.current
      const pasted = text
        .replace(/\0/g, "")
        .replace(/[\r\n]+/g, "")
        .trim()
      if (!pasted || !current || current.kind === "addChoice") return
      if (current?.kind === "connect") {
        const key = current.mode === "uri" ? "uri" : fieldsOf(current)[current.fieldIndex]
        if (!key) return
        const nextValue = (current.values[key] ?? "") + pasted
        const next: SettingsForm = { ...current, values: { ...current.values, [key]: nextValue } }
        formRef.current = next
        draftRef.current = nextValue
        setFormState(next)
        setDraftState(nextValue)
        return
      }
      draftRef.current += pasted
      setDraftState(draftRef.current)
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
        /* The confirm dialog is a promise boundary by nature (React state
           round-trip); it is lifted once and the delete composes after it —
           one program, one fork, no `.then` chain. */
        Effect.runFork(
          Effect.gen(function* () {
            const ok = yield* Effect.promise(() =>
              dialog.confirm({
                title: `Delete database "${item.label}"?`,
                body: "This removes the database and its connection settings.",
                okLabel: "delete",
                danger: true,
              })
            )
            if (!ok) return
            yield* configStore.deleteDatabase(item.refId as DatabaseId)
            toasts.push("success", "database deleted")
            refresh()
          }).pipe(
            Effect.catchAll(cause =>
              Effect.sync(() => {
                errorLog.append("settings.deleteDatabase", cause)
                toasts.push("error", `failed to delete: ${describeError(cause)}`)
              })
            )
          )
        )
        return
      }
      Effect.runFork(
        Effect.gen(function* () {
          yield* configStore.deleteProject(item.refId as ProjectId)
          toasts.push("success", "project deleted")
          refresh()
        }).pipe(
          Effect.catchAll(cause =>
            Effect.sync(() => {
              errorLog.append("settings.deleteProject", cause)
              toasts.push("error", `failed to delete: ${describeError(cause)}`)
            })
          )
        )
      )
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
        Effect.runFork(
          Effect.gen(function* () {
            yield* configStore.updateDatabase(current.databaseId, { name })
            toasts.push("success", `renamed to ${name}`)
            openForm(null)
            refresh()
          }).pipe(
            Effect.catchAll(cause =>
              Effect.sync(() => {
                errorLog.append("settings.rename", cause)
                toasts.push("error", `rename failed: ${describeError(cause)}`)
              })
            )
          )
        )
        return
      }
      const name = draftRef.current.trim()
      if (!name) {
        toasts.push("error", "a name is required")
        return
      }
      Effect.runFork(
        Effect.gen(function* () {
          yield* configStore.createProject({ name })
          toasts.push("success", "project added")
          openForm(null)
          refresh()
        }).pipe(
          Effect.catchAll(cause =>
            Effect.sync(() => {
              toasts.push("error", `failed to add project: ${describeError(cause)}`)
              openForm(null)
              refresh()
            })
          )
        )
      )
    },
    cancelForm: () => openForm(null),
    testing,
    completions,
  }
}
