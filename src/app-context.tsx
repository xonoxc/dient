/**
 * React contexts that glue the Effect services into the TUI.
 *
 * `ServicesProvider` feeds the resolved service instances (ConfigStore,
 * ConnectionManager, SchemaInspector, QueryExecutor) to every screen. Pieces
 * that need real configuration, keyboard routing, or life in the frame loop
 * live in the contexts below so tests can seed them with mocks and drive key
 * events through the real renderer.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { ConfigStoreService } from "@/config"
import type { ConnectionManagerService } from "@/connection/connection-manager"
import type { QueryExecutorService } from "@/query/query-executor"
import type { SchemaInspectorService } from "@/inspector"
import type { Engine } from "@/domain"
import type { VimMode } from "@/vim"

export interface AppServices {
  readonly configStore: ConfigStoreService
  readonly connectionManager: ConnectionManagerService
  readonly schemaInspector: SchemaInspectorService
  readonly queryExecutor: QueryExecutorService
}

const ServicesContext = createContext<AppServices | null>(null)

export function ServicesProvider({ services, children }: { services: AppServices; children?: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>
}

export function useServices(): AppServices {
  const services = useContext(ServicesContext)
  if (!services) throw new Error("useServices() used outside of a <ServicesProvider>")
  return services
}

/* ------------------------------------------------------------------ router */

export type AppScreen = "explorer" | "settings"

export interface RouterState {
  readonly screen: AppScreen
  readonly setScreen: (screen: AppScreen) => void
  readonly helpOpen: boolean
  readonly openHelp: () => void
  readonly closeHelp: () => void
}

const RouterContext = createContext<RouterState | null>(null)

export function RouterProvider({ children }: { children?: ReactNode }) {
  const [screen, setScreen] = useState<AppScreen>("explorer")
  const [helpOpen, setHelpOpen] = useState(false)
  const value = useMemo<RouterState>(
    () => ({
      screen,
      setScreen,
      helpOpen,
      openHelp: () => setHelpOpen(true),
      closeHelp: () => setHelpOpen(false),
    }),
    [screen, helpOpen]
  )
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
}

export function useRouter(): RouterState {
  const router = useContext(RouterContext)
  if (!router) throw new Error("useRouter() used outside of a <RouterProvider>")
  return router
}

/* ------------------------------------------------------------------ toasts */

export type ToastKind = "info" | "success" | "error" | "warning"

export interface Toast {
  readonly id: number
  readonly kind: ToastKind
  readonly text: string
}

export interface ToastState {
  readonly toasts: ReadonlyArray<Toast>
  readonly push: (kind: ToastKind, text: string, timeoutMs?: number) => void
  readonly dismiss: (id: number) => void
}

const ToastContext = createContext<ToastState | null>(null)

const TOAST_DEFAULT_MS = 3500

export function ToastProvider({ children }: { children?: ReactNode }) {
  const [toasts, setToasts] = useState<ReadonlyArray<Toast>>([])
  const nextId = useRef(1)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    setToasts(current => current.filter(toast => toast.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const push = useCallback(
    (kind: ToastKind, text: string, timeoutMs: number = TOAST_DEFAULT_MS) => {
      const id = nextId.current++
      setToasts(current => [...current.slice(-3), { id, kind, text }])
      const timer = setTimeout(() => dismiss(id), timeoutMs)
      timers.current.set(id, timer)
    },
    [dismiss]
  )

  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const value = useMemo<ToastState>(() => ({ toasts, push, dismiss }), [toasts, push, dismiss])
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
}

export function useToasts(): ToastState {
  const toasts = useContext(ToastContext)
  if (!toasts) throw new Error("useToasts() used outside of a <ToastProvider>")
  return toasts
}

/* ------------------------------------------------------------------ dialogs */

export interface ConfirmOptions {
  readonly title: string
  readonly body: string
  readonly okLabel?: string
  readonly danger?: boolean
}

export interface DialogState {
  readonly confirm: (options: ConfirmOptions) => Promise<boolean>
  readonly dialog: { readonly options: ConfirmOptions; readonly resolve: (ok: boolean) => void } | null
}

const DialogContext = createContext<DialogState | null>(null)

export function DialogProvider({ children }: { children?: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState["dialog"]>(null)

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>(resolve => {
        setDialog({ options, resolve })
      }),
    []
  )

  const value = useMemo<DialogState>(
    () => ({ confirm, dialog }),
    [confirm, dialog]
  )

  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>
}

export function useDialog(): DialogState {
  const dialog = useContext(DialogContext)
  if (!dialog) throw new Error("useDialog() used outside of a <DialogProvider>")
  return dialog
}

/* --------------------------------------------------------- session status */

/**
 * Everything the shared status bar shows. Screens push a partial here whenever
 * their own state changes, so the shell stays a dumb renderer: it owns the
 * status bar, the screens own what you see inside it.
 */
export interface SessionStatus {
  readonly mode: VimMode
  readonly engine?: Engine
  readonly connection?: string
  readonly database?: string
  readonly table?: string
  readonly rows?: number
  readonly total?: number
  readonly hints: ReadonlyArray<string>
}

export interface SessionState {
  readonly status: SessionStatus
  readonly setStatus: (patch: Partial<SessionStatus>) => void
}

const SessionContext = createContext<SessionState | null>(null)

const DEFAULT_SESSION: SessionStatus = { mode: "normal", hints: [] }

export function SessionProvider({ children }: { children?: ReactNode }) {
  const [status, setStatusState] = useState<SessionStatus>(DEFAULT_SESSION)
  const setStatus = useCallback((patch: Partial<SessionStatus>) => {
    setStatusState(current => ({ ...current, ...patch }))
  }, [])
  const value = useMemo<SessionState>(
    () => ({ status, setStatus }),
    [status, setStatus]
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSessionStatus(): SessionState {
  const session = useContext(SessionContext)
  if (!session) throw new Error("useSessionStatus() used outside of a <SessionProvider>")
  return session
}

/* ---------------------------------------------------------- command line */

/** The single-line `:` command prompt. State only; which commands it can run
    is decided where services live (see `AppRoot`), so the context stays generic. */
export interface CommandLineState {
  readonly open: boolean
  readonly text: string
  readonly openLine: () => void
  readonly closeLine: () => void
  readonly typeChar: (char: string) => void
  readonly backspace: () => void
}

const CommandLineContext = createContext<CommandLineState | null>(null)

export function CommandLineProvider({ children }: { children?: ReactNode }) {
  /* open/text are mirrored in refs so a key handler that fires between React
     commits (a human can type a whole command faster than one frame) still
     sees the current value, never a stale render closure. */
  const [open, setOpen] = useState(false)
  const [text, setText] = useState("")
  const openRef = useRef(false)
  const textRef = useRef("")

  const value = useMemo<CommandLineState>(
    () => ({
      get open() {
        return openRef.current
      },
      get text() {
        return textRef.current
      },
      openLine: () => {
        openRef.current = true
        textRef.current = ""
        setOpen(true)
        setText("")
      },
      closeLine: () => {
        openRef.current = false
        textRef.current = ""
        setOpen(false)
        setText("")
      },
      typeChar: char => {
        textRef.current += char
        setText(textRef.current)
      },
      backspace: () => {
        textRef.current = textRef.current.slice(0, -1)
        setText(textRef.current)
      },
    }),
    [open, text]
  )

  return <CommandLineContext.Provider value={value}>{children}</CommandLineContext.Provider>
}

export function useCommandLine(): CommandLineState {
  const commandLine = useContext(CommandLineContext)
  if (!commandLine) throw new Error("useCommandLine() used outside of a <CommandLineProvider>")
  return commandLine
}

/* ---------------------------------------------------------- command bus */

/** One `:` command. `match` decides if a typed line applies, `run` executes it
    with the full text (trimmed) so commands can parse their own arguments. */
export interface AppCommand {
  readonly id: string
  readonly help: string
  readonly match: (text: string) => boolean
  readonly run: (text: string) => void
}

export interface CommandBusState {
  /** Every command contributed by the shell and the screens, newest last. */
  readonly commands: ReadonlyArray<AppCommand>
  /** Register a screen-scoped command (replacing any prior command with the
      same id). Returns a disposal used by the screen's effect. */
  readonly register: (command: AppCommand) => () => void
}

const CommandBusContext = createContext<CommandBusState | null>(null)

export function CommandBusProvider({ children }: { children?: ReactNode }) {
  const byId = useRef(new Map<string, AppCommand>())
  const [version, setVersion] = useState(0)

  const value = useMemo<CommandBusState>(
    () => ({
      get commands() {
        return Array.from(byId.current.values())
      },
      register: command => {
        /* identity-guard: re-registering the same instance is a no-op so the
           version counter only bumps on real changes */
        if (byId.current.get(command.id) === command) return () => undefined
        byId.current.set(command.id, command)
        setVersion(v => v + 1)
        return () => {
          if (byId.current.get(command.id) === command) {
            byId.current.delete(command.id)
            setVersion(v => v + 1)
          }
        }
      },
    }),
    [version]
  )

  return <CommandBusContext.Provider value={value}>{children}</CommandBusContext.Provider>
}

export function useCommandBus(): CommandBusState {
  const bus = useContext(CommandBusContext)
  if (!bus) throw new Error("useCommandBus() used outside of a <CommandBusProvider>")
  return bus
}

/** Register one command for the lifetime of the calling component. The command
    is registered once; its `match`/`run` read the latest closure on demand so
    screens can pass fresh state without re-registering every frame. */
export function useCommand(command: AppCommand): void {
  const bus = useCommandBus()
  const latest = useRef(command)
  latest.current = command
  const stable = useMemo<AppCommand>(
    () => ({
      id: command.id,
      help: command.help,
      match: text => latest.current.match(text),
      run: text => latest.current.run(text),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [command.id, command.help]
  )
  /* Only the stable id/help drive (re)registration; bus.register touches refs
     and setVersion directly, so re-running on every bus version would ping-pong
     with the disposal it returns. */
  useEffect(() => bus.register(stable), [stable]) // eslint-disable-line react-hooks/exhaustive-deps
}