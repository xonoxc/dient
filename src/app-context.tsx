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
import type { ErrorLog } from "@/log/error-log"

export interface AppServices {
  readonly configStore: ConfigStoreService
  readonly connectionManager: ConnectionManagerService
  readonly schemaInspector: SchemaInspectorService
  readonly queryExecutor: QueryExecutorService
  readonly errorLog: ErrorLog
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
        setDialog({
          options,
          /* resolving also dismisses the modal: the component that opened the
             dialog learns the answer, and the provider drops the overlay */
          resolve: ok => {
            resolve(ok)
            setDialog(null)
          },
        })
      }),
    []
  )

  const value = useMemo<DialogState>(() => ({ confirm, dialog }), [confirm, dialog])

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
  /** 1-based first row on screen, when rows are paged in the database. */
  readonly rowStart?: number
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
  const value = useMemo<SessionState>(() => ({ status, setStatus }), [status, setStatus])
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
  /** Replace the whole buffer (Tab completion). */
  readonly replaceText: (text: string) => void
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
      replaceText: text => {
        textRef.current = text
        setText(text)
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

/* ---------------------------------------------------------- text input */

/** A key event as the router sees it (structurally a subset of the runtime's). */
export interface RoutedKey {
  readonly name: string
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly shift?: boolean
  readonly option?: boolean
}

/** Handles a key while it owns INSERT mode. Return true when consumed. */
export type TextKeyHandler = (key: RoutedKey) => boolean

/**
 * INSERT-mode keyboard ownership.
 *
 * The runtime fires *every* `useKeyboard` subscriber for every keypress and
 * ignores `stopPropagation`, so "who gets this key" cannot be left to each
 * handler guessing. Instead it is decided once, here:
 *
 *   - A text surface (a settings form, the finder, `/` search, a cell editor)
 *     registers a handler when it opens and releases it when it closes.
 *   - The single app-level dispatcher sends the key to that handler and stops.
 *   - NORMAL-mode bindings are only consulted when nothing owns input.
 *
 * So "in INSERT mode you can type anything" is structural: a NORMAL binding can
 * never see the key, which is what lets `:` `?` `u` `/` and every other
 * character be ordinary text inside a connection string.
 */
export interface TextInputState {
  /**
   * Reactive: a field currently owns the keyboard. This is what makes the mode
   * indicator truthful — ownership lives in a ref for dispatch, but the status
   * bar has to re-render when a field opens or closes.
   */
  readonly active: boolean
  /** The current owner's handler, or null. */
  readonly owner: () => TextKeyHandler | null
  /**
   * Route this key to the owner. Returns true when the caller must stop — the
   * key was either delivered to the owner or already delivered.
   *
   * Every `useKeyboard` subscriber sees every key and the runtime ignores
   * `stopPropagation`, so "route it once" has to be enforced here. The event
   * object is the identity that makes it exactly-once: the first subscriber to
   * route a given event delivers it, the rest see it as already handled. A
   * handler that opens a field mid-event passes that same event to `claim`, so
   * the keystroke that opened the field is never also typed into it.
   */
  readonly route: (key: RoutedKey) => boolean
  /** Register the INSERT-mode handler; returns a release function. */
  readonly claim: (handler: TextKeyHandler, cause?: RoutedKey) => () => void
}

const TextInputContext = createContext<TextInputState | null>(null)

export function TextInputProvider({ children }: { children?: ReactNode }) {
  /* A stack, not a single slot: a field can open over another (the cell editor
     opened from a search), and closing it must restore the one beneath. */
  const stackRef = useRef<TextKeyHandler[]>([])
  /* Events already delivered to an owner, keyed by identity so the guarantee
     holds no matter which subscriber runs first. */
  const routedRef = useRef<WeakSet<object>>(new WeakSet<object>())
  /* Reactive mirror of the stack depth. Ownership itself must stay in a ref
     (routes are read during key dispatch, before any render), but the status
     bar needs to *re-render* when a field opens or closes — that is what
     "insert mode" is. */
  const [depth, setDepth] = useState(0)

  const value = useMemo<TextInputState>(
    () => ({
      active: stackRef.current.length > 0,
      owner: () => stackRef.current[stackRef.current.length - 1] ?? null,
      route: key => {
        const event = key as unknown as object
        if (routedRef.current.has(event)) return true
        const handler = stackRef.current[stackRef.current.length - 1]
        if (!handler) return false
        routedRef.current.add(event)
        handler(key)
        return true
      },
      claim: (handler, cause) => {
        /* The keystroke that opened this field belongs to NORMAL mode. */
        if (cause !== undefined) routedRef.current.add(cause as unknown as object)
        const entry = { handler, released: false }
        stackRef.current.push(entry.handler)
        setDepth(stackRef.current.length)
        return () => {
          if (entry.released) return
          entry.released = true
          const index = stackRef.current.lastIndexOf(entry.handler)
          if (index >= 0) stackRef.current.splice(index, 1)
          setDepth(stackRef.current.length)
        }
      },
    }),
    [depth]
  )

  return <TextInputContext.Provider value={value}>{children}</TextInputContext.Provider>
}

export function useTextInput(): TextInputState {
  const textInput = useContext(TextInputContext)
  if (!textInput) throw new Error("useTextInput() used outside of a <TextInputProvider>")
  return textInput
}

/* ------------------------------------------------------- config revision */

export interface ConfigRevisionState {
  /** Bumped whenever the config store is mutated. */
  readonly revision: number
  /** The project a caller wants revealed, if any. */
  readonly reveal: string | null
  /**
   * Announce that config data changed. `revealProjectId` asks listeners to
   * expand that project, so a database created in settings is actually visible
   * in the explorer sidebar instead of hiding under a collapsed project.
   */
  readonly bump: (revealProjectId?: string) => void
}

const ConfigRevisionContext = createContext<ConfigRevisionState | null>(null)

export function ConfigRevisionProvider({ children }: { children?: ReactNode }) {
  const [state, setState] = useState<{ revision: number; reveal: string | null }>({ revision: 0, reveal: null })

  const value = useMemo<ConfigRevisionState>(
    () => ({
      revision: state.revision,
      reveal: state.reveal,
      bump: revealProjectId => setState(current => ({ revision: current.revision + 1, reveal: revealProjectId ?? null })),
    }),
    [state]
  )

  return <ConfigRevisionContext.Provider value={value}>{children}</ConfigRevisionContext.Provider>
}

export function useConfigRevision(): ConfigRevisionState {
  const value = useContext(ConfigRevisionContext)
  if (!value) throw new Error("useConfigRevision() used outside of a <ConfigRevisionProvider>")
  return value
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
