/**
 * Settings screen state. Renders the config tree (projects → databases →
 * connections) and drives keyboard forms for adding databases and connections,
 * deleting any node, and testing a connection from the tree row.
 *
 * The tree is a flattened list of `SettingsListItem` nodes; each carries its
 * parent id so CRUD always lands on the right foreign key (a connection form
 * needs the database that will own it, a database form the owning project).
 *
 * Form state (which form is open, its draft buffer, the picked engine) is
 * mirrored into refs: keyboard handlers fire between React commits when a user
 * (or a test pressing whole chords) types faster than a frame, so every action
 * reads the live value instead of a stale render closure — the same trick the
 * shell's command line and the cell editor use.
 *
 * Everything is fire-and-forget from the hook: React is the frame loop, so a
 * saved/removed row refreshes the tree through a follow-up `refresh()`.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { Effect } from "effect"
import { useDialog, useServices, useToasts } from "@/app-context"
import { connectionLabel } from "@/connection/config"
import { completePath, pathCandidates } from "@/fs/path-complete"
import type { CreateConnectionInput, ConfigStoreService } from "@/config"
import type { Connection, ConnectionId, Database, DatabaseId, Project, ProjectId } from "@/domain"
import type { Engine } from "@/domain"

export type SettingsKind = "project" | "database" | "connection"

export interface SettingsListItem {
  readonly id: string
  readonly kind: SettingsKind
  readonly refId: string
  readonly parentId: string | null
  readonly label: string
  readonly meta: string | null
  readonly depth: number
  readonly expanded: boolean
}

export type ConnectionFormField = "host" | "port" | "user" | "password" | "filename" | "defaultDatabase"

export type SettingsForm =
  | { readonly kind: "project" }
  | { readonly kind: "database"; readonly projectId: ProjectId }
  | {
      readonly kind: "connection"
      readonly databaseId: DatabaseId
      readonly fieldIndex: number
      readonly values: Partial<Record<ConnectionFormField, string>>
    }

/** Which fields each engine's connection form exposes, in Tab order. */
export const CONNECTION_FIELDS: Record<Engine, readonly ConnectionFormField[]> = {
  sqlite: ["filename"],
  postgres: ["host", "port", "user", "password", "defaultDatabase"],
  mysql: ["host", "port", "user", "password", "defaultDatabase"],
}

export const FIELD_LABEL: Record<ConnectionFormField, string> = {
  host: "host",
  port: "port",
  user: "user",
  password: "password",
  filename: "filename",
  defaultDatabase: "database",
}

export interface UseSettingsResult {
  readonly items: ReadonlyArray<SettingsListItem>
  readonly cursor: number
  readonly form: SettingsForm | null
  readonly draft: string
  readonly engine: Engine
  readonly field: ConnectionFormField | null
  readonly fieldIndex: number
  readonly fieldCount: number
  readonly typeChar: (char: string) => void
  readonly backspace: () => void
  readonly setDraft: (draft: string) => void
  readonly cycleEngine: () => void
  readonly tab: () => void
  readonly move: (delta: -1 | 1) => void
  readonly jump: (position: "first" | "last") => void
  readonly toggle: () => void
  readonly add: () => void
  readonly remove: () => void
  readonly testConnection: () => void
  readonly submitForm: () => void
  readonly cancelForm: () => void
  /** Non-null while a connection test is in flight (renders "connecting…"). */
  readonly testing: string | null
  /** Filesystem matches for the active filename field (sqlite forms). */
  readonly completions: ReadonlyArray<string>
}

export const buildSettingsTree = (
  projects: ReadonlyArray<Project>,
  databases: ReadonlyMap<ProjectId, ReadonlyArray<Database>>,
  connections: ReadonlyMap<DatabaseId, ReadonlyArray<Connection>>,
  expanded: ReadonlySet<string>
): ReadonlyArray<SettingsListItem> => {
  const items: SettingsListItem[] = []
  for (const project of projects) {
    const projectExpanded = expanded.has(project.id)
    items.push({ id: `project:${project.id}`, kind: "project", refId: project.id, parentId: null, label: project.name, meta: null, depth: 0, expanded: projectExpanded })
    if (!projectExpanded) continue
    for (const database of databases.get(project.id) ?? []) {
      const databaseExpanded = expanded.has(database.id)
      items.push({ id: `database:${database.id}`, kind: "database", refId: database.id, parentId: project.id, label: database.name, meta: database.engine, depth: 1, expanded: databaseExpanded })
      if (!databaseExpanded) continue
      for (const connection of connections.get(database.id) ?? []) {
        items.push({ id: `connection:${connection.id}`, kind: "connection", refId: connection.id, parentId: database.id, label: connectionLabel(connection), meta: null, depth: 2, expanded: false })
      }
    }
  }
  return items
}

const ENGINES: ReadonlyArray<Engine> = ["postgres", "mysql", "sqlite"]

export const useSettings = (): UseSettingsResult => {
  const { configStore, connectionManager, errorLog } = useServices()
  const toasts = useToasts()
  const dialog = useDialog()

  const [projects, setProjects] = useState<ReadonlyArray<Project>>([])
  const [databases, setDatabases] = useState<ReadonlyMap<ProjectId, ReadonlyArray<Database>>>(new Map())
  const [connections, setConnections] = useState<ReadonlyMap<DatabaseId, ReadonlyArray<Connection>>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState(0)
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

  const connectionRow = (databaseId: DatabaseId, connectionId: ConnectionId): Connection | undefined =>
    connections.get(databaseId)?.find(connection => connection.id === connectionId)

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
            const connRows =
              (await Effect.runPromise(configStore.listConnections(database.id)).catch(() => null)) ?? []
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

  const clamp = (next: number): number => Math.max(0, Math.min(Math.max(items.length - 1, 0), next))

  const fieldsOf = (form: SettingsForm): readonly ConnectionFormField[] => {
    if (form.kind === "connection") {
      return CONNECTION_FIELDS[databaseById(form.databaseId)?.engine ?? "sqlite"]
    }
    return []
  }

  const field = form?.kind === "connection" ? fieldsOf(form)[form.fieldIndex] ?? null : null
  const fieldCount = form?.kind === "connection" ? fieldsOf(form).length : 0
  const fieldIndex = form?.kind === "connection" ? form.fieldIndex : 0

  /* Live path matches for the sqlite filename field, shown under the form. */
  const completions = useMemo(() => {
    if (form?.kind !== "connection") return []
    if (databaseById(form.databaseId)?.engine !== "sqlite") return []
    if (field !== "filename") return []
    return pathCandidates(draft)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, draft, databases])

  const openForm = (next: SettingsForm | null): void => {
    formRef.current = next
    const key = next?.kind === "connection" ? (fieldsOf(next)[next.fieldIndex] ?? null) : null
    const buffer = next?.kind === "connection" && key ? (next.values[key] ?? "") : ""
    draftRef.current = buffer
    setFormState(next)
    setDraftState(buffer)
  }

  const typeChar = (char: string): void => {
    const current = formRef.current
    if (!current || current.kind !== "connection") {
      draftRef.current += char
      setDraftState(draftRef.current)
      return
    }
    const key = fieldsOf(current)[current.fieldIndex]
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
    if (!current || current.kind !== "connection") {
      draftRef.current = draftRef.current.slice(0, -1)
      setDraftState(draftRef.current)
      return
    }
    const key = fieldsOf(current)[current.fieldIndex]
    if (!key) return
    const text = (current.values[key] ?? "").slice(0, -1)
    const next: SettingsForm = { ...current, values: { ...current.values, [key]: text } }
    formRef.current = next
    draftRef.current = text
    setFormState(next)
    setDraftState(text)
  }

  const connectionForm = (databaseId: DatabaseId): SettingsForm => ({
    kind: "connection",
    databaseId,
    fieldIndex: 0,
    values: {},
  })

  const submitConnectionForm = (form: Extract<SettingsForm, { kind: "connection" }>): void => {
    const parentEngine = databaseById(form.databaseId)?.engine ?? "sqlite"
    const values = form.values
    const filename = values.filename?.trim() ?? ""
    const host = values.host?.trim() ?? ""
    const port = values.port?.trim() ?? ""

    const finish = (): void => {
      openForm(null)
      refresh()
    }

    if (parentEngine === "sqlite") {
      if (!filename) {
        toasts.push("error", "a sqlite connection requires a filename")
        return
      }
      void Effect.runPromise(configStore.createConnection({ databaseId: form.databaseId, filename }))
        .then(() => {
          toasts.push("success", `connection added (${filename})`)
          finish()
        })
        .catch(cause => {
          errorLog.append("settings.createConnection", cause)
          toasts.push("error", `failed to add connection: ${String(cause)}`)
          finish()
        })
    } else {
      if (!host) {
        toasts.push("error", "a connection requires a host")
        return
      }
      if (port && !/^\d+$/.test(port)) {
        toasts.push("error", "port must be a number")
        return
      }
      const input: CreateConnectionInput = {
        databaseId: form.databaseId,
        host,
        ...(port ? { port: Number(port) } : {}),
        ...(values.user?.trim() ? { user: values.user.trim() } : {}),
        ...(values.password?.trim() ? { password: values.password.trim() } : {}),
        ...(values.defaultDatabase?.trim() ? { defaultDatabase: values.defaultDatabase.trim() } : {}),
      }
      void Effect.runPromise(configStore.createConnection(input))
        .then(() => {
          toasts.push("success", `connection added (${host})`)
          finish()
        })
        .catch(cause => {
          errorLog.append("settings.createConnection", cause)
          toasts.push("error", `failed to add connection: ${String(cause)}`)
          finish()
        })
    }
  }

  return {
    items,
    cursor,
    form,
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
      const next = ENGINES[(ENGINES.indexOf(engineRef.current) + 1) % ENGINES.length]!
      engineRef.current = next
      setEngineState(next)
    },
    tab: () => {
      const current = formRef.current
      if (!current) return
      if (current.kind === "database") {
        const next = ENGINES[(ENGINES.indexOf(engineRef.current) + 1) % ENGINES.length]!
        engineRef.current = next
        setEngineState(next)
      } else if (current.kind === "connection") {
        /* A single-field sqlite form has nothing to tab between — Tab becomes
           shell-style path completion of the filename instead. */
        const fields = fieldsOf(current)
        if (fields.length === 1 && databaseById(current.databaseId)?.engine === "sqlite") {
          draftRef.current = completePath(draftRef.current)
          setDraftState(draftRef.current)
          return
        }
        const fieldIndexNext = (current.fieldIndex + 1) % fields.length
        const next: SettingsForm = { ...current, fieldIndex: fieldIndexNext }
        formRef.current = next
        const key = fields[fieldIndexNext] ?? null
        const buffer = key ? (next.values[key] ?? "") : ""
        draftRef.current = buffer
        setFormState(next)
        setDraftState(buffer)
      }
    },
    move: delta => setCursor(current => clamp(current + delta)),
    jump: position => setCursor(position === "last" ? clamp(items.length) : 0),
    toggle: () => {
      const item = items[Math.min(cursor, items.length - 1)]
      if (!item || item.kind === "connection") return
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
        openForm({ kind: "project" })
        return
      }
      if (item.kind === "project") openForm({ kind: "database", projectId: item.refId as ProjectId })
      else if (item.kind === "database") openForm(connectionForm(item.refId as DatabaseId))
      else openForm(connectionForm(item.parentId as DatabaseId))
    },
    remove: () => {
      const item = items[Math.min(cursor, items.length - 1)]
      if (!item) return
      if (item.kind === "connection") {
        void dialog
          .confirm({
            title: `Delete connection "${item.label}"?`,
            body: "This removes the saved connection settings.",
            okLabel: "delete",
            danger: true,
          })
          .then(ok => {
            if (!ok) return
            void Effect.runPromise(configStore.deleteConnection(item.refId as ConnectionId))
              .then(() => {
                toasts.push("success", "connection deleted")
                refresh()
              })
              .catch(cause => {
                errorLog.append("settings.deleteConnection", cause)
                toasts.push("error", `failed to delete connection: ${String(cause)}`)
              })
          })
        return
      }
      const del = item.kind === "project" ? configStore.deleteProject(item.refId as ProjectId) : configStore.deleteDatabase(item.refId as DatabaseId)
      void Effect.runPromise(del)
        .then(() => {
          toasts.push("success", `${item.kind} deleted`)
          refresh()
        })
        .catch(cause => {
          errorLog.append(`settings.delete${item.kind}`, cause)
          toasts.push("error", `failed to delete ${item.kind}: ${String(cause)}`)
        })
    },
    testConnection: () => {
      const item = items[Math.min(cursor, items.length - 1)]
      if (!item || item.kind !== "connection") {
        toasts.push("info", "move to a connection row (j/k) and press t to test it")
        return
      }
      if (testingRef.current) return
      const databaseId = item.parentId as DatabaseId
      const database = databaseById(databaseId)
      const connection = connectionRow(databaseId, item.refId as ConnectionId)
      if (!database || !connection) {
        toasts.push("error", "connection not found")
        return
      }
      const label = connectionLabel(connection)
      testingRef.current = label
      setTesting(label)
      toasts.push("info", `testing ${label}…`)
      void Effect.runPromise(connectionManager.pingConnection(database, connection))
        .then(ok => {
          testingRef.current = null
          setTesting(null)
          if (ok) toasts.push("success", `${label} ok (${database.engine})`)
          else toasts.push("error", `${label} failed`)
        })
        .catch(cause => {
          testingRef.current = null
          setTesting(null)
          errorLog.append("settings.testConnection", cause)
          toasts.push("error", `${label} failed: ${String(cause)}`)
        })
    },
    submitForm: () => {
      const current = formRef.current
      if (!current) return
      if (current.kind === "connection") {
        submitConnectionForm(current)
        return
      }
      const name = draftRef.current.trim()
      if (!name) {
        toasts.push("error", "a name is required")
        return
      }
      if (current.kind === "database") {
        const projectId = current.projectId
        void Effect.runPromise(configStore.createDatabase({ projectId, name, engine: engineRef.current }))
          .then(() => {
            toasts.push("success", `database added (${engineRef.current})`)
            setExpanded(current => new Set(current).add(projectId))
            openForm(null)
            refresh()
          })
          .catch(cause => {
            errorLog.append("settings.createDatabase", cause)
            toasts.push("error", `failed to add database: ${String(cause)}`)
            openForm(null)
            refresh()
          })
      } else {
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
      }
    },
    cancelForm: () => openForm(null),
    testing,
    completions,
  }
}