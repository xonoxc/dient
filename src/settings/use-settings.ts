/**
 * Settings screen. Shows the raw config tree (projects → databases →
 * connections) and lets the user add/remove projects and databases through a
 * small keyboard-driven form. Connection CRUD lands in a later phase; here the
 * tree is read-only at the connection level but fully navigable.
 */
import { useEffect, useMemo, useState } from "react"
import { Effect } from "effect"
import { useServices, useToasts } from "@/app-context"
import { connectionLabel } from "@/connection/config"
import type { ConfigStoreService } from "@/config"
import type { Connection, Database, DatabaseId, Project, ProjectId } from "@/domain"
import type { Engine } from "@/domain"

export type SettingsKind = "project" | "database" | "connection"

export interface SettingsListItem {
  readonly id: string
  readonly kind: SettingsKind
  readonly refId: string
  readonly label: string
  readonly meta: string | null
  readonly depth: number
  readonly expanded: boolean
}

export interface SettingsForm {
  readonly kind: "project" | "database"
  readonly projectId?: ProjectId
}

export interface UseSettingsResult {
  readonly items: ReadonlyArray<SettingsListItem>
  readonly cursor: number
  readonly form: SettingsForm | null
  readonly draft: string
  readonly engine: Engine
  readonly setDraft: (draft: string) => void
  readonly cycleEngine: () => void
  readonly move: (delta: -1 | 1) => void
  readonly jump: (position: "first" | "last") => void
  readonly toggle: () => void
  readonly add: () => void
  readonly remove: () => void
  readonly submitForm: () => void
  readonly cancelForm: () => void
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
    items.push({ id: `project:${project.id}`, kind: "project", refId: project.id, label: project.name, meta: null, depth: 0, expanded: projectExpanded })
    if (!projectExpanded) continue
    for (const database of databases.get(project.id) ?? []) {
      const databaseExpanded = expanded.has(database.id)
      items.push({ id: `database:${database.id}`, kind: "database", refId: database.id, label: database.name, meta: database.engine, depth: 1, expanded: databaseExpanded })
      if (!databaseExpanded) continue
      for (const connection of connections.get(database.id) ?? []) {
        items.push({ id: `connection:${connection.id}`, kind: "connection", refId: connection.id, label: connectionLabel(connection), meta: null, depth: 2, expanded: false })
      }
    }
  }
  return items
}

const ENGINES: ReadonlyArray<Engine> = ["postgres", "mysql", "sqlite"]

export const useSettings = (): UseSettingsResult => {
  const { configStore } = useServices()
  const toasts = useToasts()

  const [projects, setProjects] = useState<ReadonlyArray<Project>>([])
  const [databases, setDatabases] = useState<ReadonlyMap<ProjectId, ReadonlyArray<Database>>>(new Map())
  const [connections, setConnections] = useState<ReadonlyMap<DatabaseId, ReadonlyArray<Connection>>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState(0)
  const [form, setForm] = useState<SettingsForm | null>(null)
  const [draft, setDraft] = useState("")
  const [engine, setEngine] = useState<Engine>("postgres")

  const refresh = (): void => {
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
  }

  useEffect(refresh, [configStore])

  const items = useMemo(
    () => buildSettingsTree(projects, databases, connections, expanded),
    [projects, databases, connections, expanded]
  )

  const clamp = (next: number): number => Math.max(0, Math.min(Math.max(items.length - 1, 0), next))

  const run = async <A, E>(store: Effect.Effect<A, E>): Promise<A | null> =>
    Effect.runPromise(store).catch(() => null)

  return {
    items,
    cursor,
    form,
    draft,
    engine,
    setDraft,
    cycleEngine: () => setEngine(current => ENGINES[(ENGINES.indexOf(current) + 1) % ENGINES.length]!),
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
      setForm(item?.kind === "database" ? { kind: "database", projectId: item.refId as ProjectId } : { kind: "project" })
      setDraft("")
    },
    remove: async () => {
      const item = items[Math.min(cursor, items.length - 1)]
      if (!item) return
      if (item.kind === "connection") {
        toasts.push("info", "connection CRUD lands in a later phase")
        return
      }
      if (item.kind === "project") {
        await run(configStore.deleteProject(item.refId as ProjectId))
      } else {
        await run(configStore.deleteDatabase(item.refId as DatabaseId))
      }
      toasts.push("success", `${item.kind} deleted`)
      refresh()
    },
    submitForm: async () => {
      if (!form || draft.trim() === "") return
      if (form.kind === "project") {
        await run(configStore.createProject({ name: draft.trim() }))
        toasts.push("success", "project added")
      } else if (form.projectId) {
        await run(configStore.createDatabase({ projectId: form.projectId, name: draft.trim(), engine }))
        toasts.push("success", `database added (${engine})`)
        setExpanded(current => new Set(current).add(form.projectId!))
      }
      setForm(null)
      setDraft("")
      refresh()
    },
    cancelForm: () => {
      setForm(null)
      setDraft("")
    },
  }
}