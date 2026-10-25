/** RabbitMQ's colorful queue, exchange, binding, and message workbench. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Effect } from "effect"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import type { ScrollBoxRenderable } from "@opentui/core"
import {
  useCommandLine,
  useDialog,
  useRouter,
  useServices,
  useSessionStatus,
  useTextInput,
  useToasts,
} from "@/app-context"
import type { ActiveExplorer } from "@/explorer/use-explorer"
import { editTextInEditor } from "@/editor/edit-text-in-editor"
import { normalModeKey } from "@/ui/text-entry"
import { LoadingIndicator } from "@/ui/loading-indicator"
import { writeSystemClipboard } from "@/ui/clipboard"
import type { ActiveConnection } from "@/drivers/types"
import type { RabbitBinding, RabbitExchange, RabbitMessage, RabbitQueue } from "@/rabbitmq/driver"
import { useTheme } from "@/theme-context"
import { describeError } from "@/errors/describe"
import { wrapText } from "@/explorer/cell-viewer"

type WorkspaceTab = "queues" | "exchanges" | "bindings" | "messages"
type QueueSort = "manual" | "name" | "depth" | "consumers"

const TABS: ReadonlyArray<{ readonly id: WorkspaceTab; readonly label: string }> = [
  { id: "queues", label: "QUEUES" },
  { id: "exchanges", label: "EXCHANGES" },
  { id: "bindings", label: "ROUTES" },
  { id: "messages", label: "MESSAGES" },
]

const clampCursor = (cursor: number, length: number): number => Math.max(0, Math.min(cursor, length - 1))

const asJsonText = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const payloadPreview = (value: string): string => {
  try {
    return JSON.stringify(JSON.parse(value)) ?? value
  } catch {
    return value.replace(/[\r\n\t]+/g, " ↵ ")
  }
}

const payloadDocument = (value: string): string => {
  try {
    return JSON.stringify(JSON.parse(value), null, 2) ?? value
  } catch {
    return value
  }
}

const parseEditorJson = (text: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a JSON object")
  }
  return value as Record<string, unknown>
}

const volumeBar = (value: number, max: number, width = 16): string => {
  const filled = Math.max(0, Math.min(width, Math.round((value / Math.max(max, 1)) * width)))
  return `${"▰".repeat(filled)}${"▱".repeat(width - filled)}`
}

export function RabbitMqWorkspace({ active, focused }: { readonly active: ActiveExplorer; readonly focused: boolean }) {
  const theme = useTheme()
  const c = theme.colors
  const { connectionManager, rabbitmqDriver } = useServices()
  const { setStatus } = useSessionStatus()
  const toasts = useToasts()
  const dialog = useDialog()
  const router = useRouter()
  const commandLine = useCommandLine()
  const textInput = useTextInput()
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()

  const [handle, setHandle] = useState<ActiveConnection | null>(null)
  const [queues, setQueues] = useState<ReadonlyArray<RabbitQueue>>([])
  const [exchanges, setExchanges] = useState<ReadonlyArray<RabbitExchange>>([])
  const [bindings, setBindings] = useState<ReadonlyArray<RabbitBinding>>([])
  const [messages, setMessages] = useState<ReadonlyArray<RabbitMessage>>([])
  const [tab, setTab] = useState<WorkspaceTab>("queues")
  const [queueSort, setQueueSort] = useState<QueueSort>("manual")
  const [queueOrder, setQueueOrder] = useState<ReadonlyArray<string>>([])
  const [cursor, setCursor] = useState(0)
  const [messageCursor, setMessageCursor] = useState(0)
  const [messageQueue, setMessageQueue] = useState("")
  const [reverseMessages, setReverseMessages] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const editorBusyRef = useRef(false)
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)

  useEffect(() => {
    let cancelled = false
    setHandle(null)
    setQueues([])
    setExchanges([])
    setBindings([])
    setMessages([])
    setQueueOrder([])
    setQueueSort("manual")
    setTab("queues")
    setCursor(0)
    setMessageCursor(0)
    setMessageQueue("")
    setError(null)
    Effect.runPromise(connectionManager.connect(active.id)).then(
      connected => {
        if (!cancelled) setHandle(connected)
      },
      cause => {
        if (!cancelled) setError(describeError(cause))
      }
    )
    return () => {
      cancelled = true
    }
  }, [active.id, connectionManager])

  const refresh = useCallback(async () => {
    if (!handle) return
    setLoading(true)
    setError(null)
    try {
      const [nextQueues, nextExchanges, nextBindings] = await Effect.runPromise(
        Effect.all(
          [
            rabbitmqDriver.listQueues(handle),
            rabbitmqDriver.listExchanges(handle),
            rabbitmqDriver.listBindings(handle),
          ],
          { concurrency: 3 }
        )
      )
      setQueues(nextQueues)
      setExchanges(nextExchanges)
      setBindings(nextBindings.filter(binding => binding.destination_type === "queue"))
      setQueueOrder(current => {
        const names = nextQueues.map(queue => queue.name).sort((a, b) => a.localeCompare(b))
        return [...current.filter(name => names.includes(name)), ...names.filter(name => !current.includes(name))]
      })
    } catch (cause) {
      const message = describeError(cause)
      setError(message)
      toasts.push("error", `RabbitMQ refresh failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }, [handle, rabbitmqDriver, toasts])

  useEffect(() => {
    if (handle) void refresh()
  }, [handle, refresh])

  const currentQueues = useMemo(() => {
    const byName = new Map(queues.map(queue => [queue.name, queue]))
    if (queueSort === "name") return [...queues].sort((a, b) => a.name.localeCompare(b.name))
    if (queueSort === "depth") return [...queues].sort((a, b) => (b.messages ?? 0) - (a.messages ?? 0))
    if (queueSort === "consumers") return [...queues].sort((a, b) => (b.consumers ?? 0) - (a.consumers ?? 0))
    return [
      ...queueOrder.map(name => byName.get(name)).filter((queue): queue is RabbitQueue => queue !== undefined),
      ...queues.filter(queue => !queueOrder.includes(queue.name)),
    ]
  }, [queues, queueOrder, queueSort])

  const selectedQueue = tab === "queues" ? (currentQueues[clampCursor(cursor, currentQueues.length)] ?? null) : null
  const currentExchanges = exchanges.filter(exchange => exchange.name !== "")
  const selectedExchange =
    tab === "exchanges" ? (currentExchanges[clampCursor(cursor, currentExchanges.length)] ?? null) : null
  const currentBindings = bindings
  const selectedBinding =
    tab === "bindings" ? (currentBindings[clampCursor(cursor, currentBindings.length)] ?? null) : null
  const shownMessages = reverseMessages ? [...messages].reverse() : messages
  const selectedMessage = shownMessages[clampCursor(messageCursor, shownMessages.length)]
  const headerContext =
    tab === "queues" && selectedQueue
      ? `QUEUE · ${selectedQueue.name}`
      : tab === "exchanges" && selectedExchange
        ? `EXCHANGE · ${selectedExchange.name}`
        : tab === "bindings" && selectedBinding
          ? `ROUTE · ${selectedBinding.source || "default"} → ${selectedBinding.destination}`
          : tab === "messages" && messageQueue
            ? `QUEUE · ${messageQueue}`
            : null
  const readyCount = queues.reduce((total, queue) => total + (queue.messages_ready ?? 0), 0)
  const unackedCount = queues.reduce((total, queue) => total + (queue.messages_unacknowledged ?? 0), 0)
  const maxDepth = Math.max(1, ...queues.map(queue => queue.messages_ready ?? 0))
  const contentWidth = Math.max(16, width - 2 - 2 - 32 - 1)
  const headerContextWidth = Math.max(8, Math.min(48, contentWidth - 58))
  const showInspector = contentWidth >= 88
  const listWidth = showInspector ? Math.floor(contentWidth * 0.46) : contentWidth
  const inspectorWidth = Math.max(18, contentWidth - listWidth - 3)

  useEffect(() => {
    const box = scrollRef.current
    if (!box) return
    const index = tab === "messages" ? messageCursor : cursor
    const max = Math.max(0, box.scrollHeight - box.height)
    const rowHeight = tab === "queues" ? 1 : 2
    box.scrollTop = Math.max(0, Math.min(max, index * rowHeight - Math.floor(box.height / 2)))
  }, [
    tab,
    cursor,
    messageCursor,
    currentQueues.length,
    currentExchanges.length,
    currentBindings.length,
    shownMessages.length,
  ])

  const reloadMessages = useCallback(async () => {
    if (!handle || !messageQueue) return
    setLoading(true)
    try {
      const next = await Effect.runPromise(rabbitmqDriver.peekMessages(handle, messageQueue, 40))
      setMessages(next)
      setMessageCursor(current => clampCursor(current, next.length))
    } catch (cause) {
      toasts.push("error", `could not peek ${messageQueue}: ${describeError(cause)}`)
    } finally {
      setLoading(false)
    }
  }, [handle, messageQueue, rabbitmqDriver, toasts])

  const run = useCallback(
    <A,>(effect: Effect.Effect<A, unknown>, success?: (value: A) => void, successText = "broker updated") => {
      if (!handle) return
      Effect.runPromise(effect).then(
        value => {
          success?.(value)
          if (successText) toasts.push("success", successText)
          void refresh()
          if (tab === "messages") void reloadMessages()
        },
        cause => toasts.push("error", describeError(cause))
      )
    },
    [handle, refresh, reloadMessages, tab, toasts]
  )

  const runEditor = (label: string, content: string, onSave: (text: string) => void, extension = ".json"): void => {
    if (editorBusyRef.current) return
    editorBusyRef.current = true
    editTextInEditor({
      renderer,
      label,
      filename: label.replace(/[^A-Za-z0-9_-]+/g, "-").toLowerCase(),
      extension,
      content,
      callbacks: {
        notice: message => toasts.push("info", message),
        error: message => toasts.push("error", message),
        done: () => {
          editorBusyRef.current = false
        },
        onSave,
      },
    })
  }

  const createQueue = (): void => {
    runEditor("New queue", asJsonText({ name: "jobs", durable: true, arguments: {} }), text => {
      try {
        const draft = parseEditorJson(text)
        const name = typeof draft.name === "string" ? draft.name.trim() : ""
        if (!name) throw new Error("queue name is required")
        if (
          draft.arguments !== undefined &&
          (draft.arguments === null || typeof draft.arguments !== "object" || Array.isArray(draft.arguments))
        ) {
          throw new Error("arguments must be a JSON object")
        }
        run(
          rabbitmqDriver.declareQueue(handle!, name, {
            durable: draft.durable !== false,
            arguments: draft.arguments as Record<string, unknown> | undefined,
          }),
          undefined,
          `declared queue ${name}`
        )
      } catch (cause) {
        toasts.push("error", `queue form: ${describeError(cause)}`)
      }
    })
  }

  const createExchange = (): void => {
    runEditor("New exchange", asJsonText({ name: "events", type: "topic", durable: true }), text => {
      try {
        const draft = parseEditorJson(text)
        const name = typeof draft.name === "string" ? draft.name.trim() : ""
        const type = draft.type
        if (!name) throw new Error("exchange name is required")
        if (type !== "direct" && type !== "fanout" && type !== "topic" && type !== "headers") {
          throw new Error("type must be direct, fanout, topic, or headers")
        }
        run(
          rabbitmqDriver.declareExchange(handle!, name, type, {
            durable: draft.durable !== false,
            autoDelete: draft.autoDelete === true,
          }),
          undefined,
          `declared exchange ${name}`
        )
      } catch (cause) {
        toasts.push("error", `exchange form: ${describeError(cause)}`)
      }
    })
  }

  const publish = (queue?: RabbitQueue, exchange?: RabbitExchange, message?: RabbitMessage): void => {
    const targetExchange = message?.exchange ?? exchange?.name ?? ""
    const initial = message
      ? asJsonText({ routingKey: message.routing_key, payload: message.payload, properties: message.properties ?? {} })
      : asJsonText({ routingKey: queue?.name ?? "", payload: "", properties: {} })
    runEditor(message ? "Edit and republish message" : "Publish message", initial, text => {
      try {
        const draft = parseEditorJson(text)
        if (typeof draft.payload !== "string") throw new Error("payload must be a string")
        const route = typeof draft.routingKey === "string" ? draft.routingKey : (queue?.name ?? "")
        const properties = draft.properties
        if (
          properties !== undefined &&
          (properties === null || typeof properties !== "object" || Array.isArray(properties))
        ) {
          throw new Error("properties must be a JSON object")
        }
        run(
          rabbitmqDriver.publish(
            handle!,
            targetExchange,
            route,
            draft.payload,
            properties as Record<string, unknown> | undefined
          ),
          routed =>
            toasts.push(
              routed ? "success" : "warning",
              routed ? "published · routed to a queue" : "published · unrouted"
            ),
          ""
        )
      } catch (cause) {
        toasts.push("error", `message form: ${describeError(cause)}`)
      }
    })
  }

  const bindQueue = (queue: RabbitQueue): void => {
    runEditor("Bind queue", asJsonText({ exchange: "", routingKey: "" }), text => {
      try {
        const draft = parseEditorJson(text)
        const exchange = typeof draft.exchange === "string" ? draft.exchange.trim() : ""
        if (!exchange) throw new Error("exchange name is required")
        const routingKey = typeof draft.routingKey === "string" ? draft.routingKey : ""
        const args = draft.arguments
        if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
          throw new Error("arguments must be a JSON object")
        }
        run(
          rabbitmqDriver.bindQueue(
            handle!,
            exchange,
            queue.name,
            routingKey,
            args as Record<string, unknown> | undefined
          ),
          undefined,
          `bound ${queue.name} to ${exchange}`
        )
      } catch (cause) {
        toasts.push("error", `binding form: ${describeError(cause)}`)
      }
    })
  }

  const peek = (queue: RabbitQueue): void => {
    if (!handle) return
    setMessageQueue(queue.name)
    setMessages([])
    setMessageCursor(0)
    setReverseMessages(false)
    setTab("messages")
    setLoading(true)
    Effect.runPromise(rabbitmqDriver.peekMessages(handle, queue.name, 40)).then(
      result => {
        setMessages(result)
        setLoading(false)
        if (result.length === 0) toasts.push("info", `${queue.name} has no ready messages`)
      },
      cause => {
        setLoading(false)
        toasts.push("error", `could not peek ${queue.name}: ${describeError(cause)}`)
      }
    )
  }

  const confirmDelete = async (kind: "queue" | "exchange", name: string): Promise<void> => {
    const ok = await dialog.confirm({
      title: `Delete ${kind} ${name}?`,
      body:
        kind === "queue" ? "This removes the queue and its messages." : "This removes the exchange and its bindings.",
      okLabel: `delete ${kind}`,
      danger: true,
    })
    if (!ok) return
    run(
      kind === "queue" ? rabbitmqDriver.deleteQueue(handle!, name) : rabbitmqDriver.deleteExchange(handle!, name),
      undefined,
      `deleted ${kind} ${name}`
    )
  }

  const purgeQueue = async (queue: RabbitQueue): Promise<void> => {
    const ok = await dialog.confirm({
      title: `Purge ${queue.name}?`,
      body: `Remove ${queue.messages_ready ?? 0} ready messages from this queue? Unacknowledged messages are not purged.`,
      okLabel: "purge ready",
      danger: true,
    })
    if (ok) run(rabbitmqDriver.purgeQueue(handle!, queue.name), undefined, `purged ${queue.name}`)
  }

  const selectTab = (next: WorkspaceTab): void => {
    setTab(next)
    setCursor(0)
  }

  const moveQueuePosition = (delta: -1 | 1): void => {
    const from = clampCursor(cursor, currentQueues.length)
    const to = Math.max(0, Math.min(currentQueues.length - 1, from + delta))
    if (from === to) return
    const names = currentQueues.map(queue => queue.name)
    const [moved] = names.splice(from, 1)
    names.splice(to, 0, moved!)
    setQueueOrder(names)
    setQueueSort("manual")
    setCursor(to)
  }

  const selectedCount =
    tab === "queues"
      ? queues.length
      : tab === "exchanges"
        ? currentExchanges.length
        : tab === "bindings"
          ? currentBindings.length
          : shownMessages.length
  const hints = useMemo(
    () =>
      tab === "queues"
        ? [
            "j/k select",
            "[/] reorder view",
            "s sort",
            "a queue",
            "m peek",
            "p publish",
            "b bind",
            "x purge",
            "d delete",
            "r refresh",
          ]
        : tab === "exchanges"
          ? ["j/k select", "a exchange", "p publish", "d delete", "r refresh"]
          : tab === "bindings"
            ? ["j/k select", "u unbind", "r refresh"]
            : ["j/k select", "y copy", "o flip view", "i edit & republish", "Esc queues"],
    [tab]
  )

  useEffect(() => {
    setStatus({
      engine: "rabbitmq",
      database: active.database.name,
      table: tab === "messages" ? `messages · ${messageQueue}` : tab,
      rows: selectedCount,
      total: selectedCount,
      hints: focused ? hints : ["2 focus RabbitMQ", "j/k sidebar", "Enter connect", "S settings"],
      mode: textInput.active ? "insert" : "normal",
    })
  }, [setStatus, active.database.name, tab, messageQueue, selectedCount, hints, focused, textInput.active])

  useKeyboard(event => {
    if (!focused || textInput.route(event) || commandLine.open || router.helpOpen || dialog.dialog) return
    const key = normalModeKey(event)
    if (key === "tab") selectTab(TABS[(TABS.findIndex(item => item.id === tab) + 1) % TABS.length]!.id)
    else if (key === "r") {
      void refresh()
      if (tab === "messages") void reloadMessages()
    } else if (key === "j" || key === "down") {
      if (tab === "messages") setMessageCursor(current => clampCursor(current + 1, shownMessages.length))
      else setCursor(current => clampCursor(current + 1, selectedCount))
    } else if (key === "k" || key === "up") {
      if (tab === "messages") setMessageCursor(current => clampCursor(current - 1, shownMessages.length))
      else setCursor(current => clampCursor(current - 1, selectedCount))
    } else if (key === "g") {
      if (tab === "messages") setMessageCursor(0)
      else setCursor(0)
    } else if (key === "G") {
      if (tab === "messages") setMessageCursor(Math.max(0, shownMessages.length - 1))
      else setCursor(Math.max(0, selectedCount - 1))
    } else if (key === "[" && tab === "queues") moveQueuePosition(-1)
    else if (key === "]" && tab === "queues") moveQueuePosition(1)
    else if (key === "s" && tab === "queues") {
      setQueueSort(current =>
        current === "manual" ? "depth" : current === "depth" ? "consumers" : current === "consumers" ? "name" : "manual"
      )
      setCursor(0)
    } else if ((key === "m" || key === "enter" || key === "return") && tab === "queues" && selectedQueue)
      peek(selectedQueue)
    else if (key === "a" && tab === "queues") createQueue()
    else if (key === "a" && tab === "exchanges") createExchange()
    else if (key === "p" && tab === "queues" && selectedQueue) publish(selectedQueue)
    else if (key === "p" && tab === "exchanges" && selectedExchange) publish(undefined, selectedExchange)
    else if (key === "b" && tab === "queues" && selectedQueue) bindQueue(selectedQueue)
    else if (key === "x" && tab === "queues" && selectedQueue) void purgeQueue(selectedQueue)
    else if (key === "d" && tab === "queues" && selectedQueue) void confirmDelete("queue", selectedQueue.name)
    else if (key === "d" && tab === "exchanges" && selectedExchange)
      void confirmDelete("exchange", selectedExchange.name)
    else if (key === "u" && tab === "bindings" && selectedBinding) {
      if (selectedBinding.source === "") {
        toasts.push("info", "default-exchange routes are implicit and cannot be removed")
      } else {
        run(rabbitmqDriver.unbindQueue(handle!, selectedBinding), undefined, "binding removed")
      }
    } else if (key === "o" && tab === "messages") setReverseMessages(current => !current)
    else if (key === "y" && tab === "messages" && selectedMessage) {
      Effect.runPromise(writeSystemClipboard(selectedMessage.payload, renderer)).then(result => {
        toasts.push(result.ok ? "success" : "warning", result.ok ? "message payload copied" : "clipboard unavailable")
      })
    } else if (key === "i" && tab === "messages" && selectedMessage) {
      if (selectedMessage.payload_encoding === "base64") {
        toasts.push("warning", "binary payloads can be viewed as base64, but editing them as text is disabled")
      } else {
        publish(undefined, undefined, selectedMessage)
      }
    } else if (key === "escape" || key === "Escape" || key === "\u001b") {
      if (tab === "messages") setTab("queues")
    } else if (key === "S") {
      router.setScreen("settings")
    }
  })

  return (
    <box flexGrow={1} flexDirection="column" overflow="hidden" backgroundColor={c.bg}>
      <box height={1} flexDirection="row" alignItems="center" paddingX={1}>
        <text fg={c.warning}>RABBITMQ</text>
        <text fg={c.accent}> / </text>
        <text fg={c.textBright}>WORKSPACE</text>
        {headerContext ? (
          <>
            <text fg={c.border}> │ </text>
            <text fg={c.textBright} width={headerContextWidth} truncate>
              {headerContext}
            </text>
          </>
        ) : null}
        <box flexGrow={1} />
        <text fg={c.textMuted}>{`  │  vhost ${active.connection.defaultDatabase || "/"}  │  `}</text>
        <text fg={handle ? c.success : c.warning}>{handle ? "● LIVE" : "○ CONNECTING"}</text>
      </box>
      <box height={1} />

      {!handle ? (
        <box flexGrow={1} alignItems="center" justifyContent="center">
          {error ? (
            <text fg={c.error}>{error}</text>
          ) : (
            <LoadingIndicator label="opening RabbitMQ management channel…" />
          )}
        </box>
      ) : (
        <>
          <box height={3} flexDirection="row" alignItems="center" paddingX={1}>
            <box
              height={3}
              flexDirection="row"
              alignItems="center"
              paddingX={1}
              border
              borderStyle="rounded"
              borderColor={c.border}
            >
              {TABS.map((item, index) => (
                <box key={item.id} flexDirection="row" alignItems="center">
                  <box width={10} alignItems="center" justifyContent="center">
                    <text fg={tab === item.id ? c.accent : c.textMuted}>{item.label}</text>
                  </box>
                  {index < TABS.length - 1 ? (
                    <box width={3} alignItems="center" justifyContent="center">
                      <text fg={c.border}>│</text>
                    </box>
                  ) : null}
                </box>
              ))}
            </box>
            <box flexGrow={1} />
            {tab === "messages" ? (
              messageQueue ? (
                <>
                  <text fg={c.textMuted}>{`${messages.length} msgs · `}</text>
                  <text fg={c.warning}>PEEK</text>
                  <text fg={c.textMuted}> requeues; order may shift</text>
                </>
              ) : (
                <text fg={c.textMuted}>NO QUEUE SELECTED · choose a queue to peek</text>
              )
            ) : (
              <text fg={c.textMuted}>
                {tab === "queues"
                  ? `${queues.length} queues · ${readyCount.toLocaleString()} ready · ${unackedCount.toLocaleString()} in flight · ${queueSort} order`
                  : tab === "exchanges"
                    ? `${currentExchanges.length} exchanges · ${bindings.length} queue routes`
                    : `${bindings.length} queue routes`}
              </text>
            )}
          </box>

          <box flexGrow={1} flexDirection="row" overflow="hidden">
            <box width={showInspector ? listWidth : undefined} flexGrow={showInspector ? 0 : 1} flexDirection="column">
              <scrollbox ref={scrollRef} flexGrow={1} scrollY verticalScrollbarOptions={{ visible: false }}>
                <box flexDirection="column" paddingX={1} paddingY={1}>
                  {loading ? <LoadingIndicator label="synchronizing broker state…" /> : null}
                  {error ? <text fg={c.error}>{error}</text> : null}

                  {tab === "queues"
                    ? currentQueues.map((queue, index) => {
                        const selected = index === clampCursor(cursor, currentQueues.length)
                        const ready = queue.messages_ready ?? 0
                        const ratio = volumeBar(
                          ready,
                          maxDepth,
                          Math.min(12, Math.max(6, Math.floor(listWidth * 0.16)))
                        )
                        const kind = queue.type ?? String(queue.arguments?.["x-queue-type"] ?? "classic")
                        return (
                          <box
                            key={queue.name}
                            flexDirection="column"
                            backgroundColor={selected && focused ? c.bgHighlight : undefined}
                          >
                            <box
                              height={1}
                              flexDirection="row"
                              backgroundColor={selected && focused ? c.bgHighlight : undefined}
                            >
                              <text fg={selected ? c.warning : c.textMuted} width={2}>
                                {selected ? "▶" : " "}
                              </text>
                              <text fg={selected ? c.textBright : c.text} width={Math.max(12, listWidth - 32)} truncate>
                                {queue.name}
                              </text>
                              <text
                                fg={kind === "quorum" ? c.info : kind === "stream" ? c.success : c.text}
                                width={8}
                                truncate
                              >
                                {kind === "classic" ? "CLASSIC" : kind.toUpperCase()}
                              </text>
                              <text fg={c.warning} width={12}>
                                {`${ready.toLocaleString()} ready`}
                              </text>
                            </box>
                            {selected ? (
                              <box
                                height={1}
                                flexDirection="row"
                                paddingLeft={3}
                                backgroundColor={focused ? c.bgHighlight : undefined}
                              >
                                <text
                                  fg={c.textBright}
                                  width={Math.max(12, listWidth - 11)}
                                  truncate
                                >{`${ratio}  ${(queue.messages ?? 0).toLocaleString()} total · ${(queue.consumers ?? 0).toLocaleString()} consumers · ${queue.durable ? "durable" : "transient"}${queue.auto_delete ? " · auto-delete" : ""}`}</text>
                                <text fg={c.textMuted} width={6}>
                                  {queue.state ?? "up"}
                                </text>
                              </box>
                            ) : null}
                          </box>
                        )
                      })
                    : null}

                  {tab === "exchanges"
                    ? currentExchanges.map((exchange, index) => {
                        const selected = index === clampCursor(cursor, currentExchanges.length)
                        const outRate = exchange.message_stats?.publish_out_details?.rate ?? 0
                        return (
                          <box
                            key={exchange.name}
                            height={2}
                            flexDirection="column"
                            backgroundColor={selected && focused ? c.bgHighlight : undefined}
                          >
                            <box height={1} flexDirection="row">
                              <text fg={selected ? c.warning : c.textMuted} width={2}>
                                {selected ? "▶" : " "}
                              </text>
                              <text fg={selected ? c.textBright : c.text} width={Math.max(12, listWidth - 36)} truncate>
                                {exchange.name}
                              </text>
                              <text fg={c.info} width={10}>
                                {exchange.type.toUpperCase()}
                              </text>
                              <text
                                fg={outRate > 0 ? c.success : c.textMuted}
                                width={19}
                                truncate
                              >{`${outRate.toFixed(2)} msg/s  ${exchange.durable ? "◆" : "◇"}`}</text>
                            </box>
                            <box
                              height={1}
                              paddingLeft={3}
                              backgroundColor={selected && focused ? c.bgHighlight : undefined}
                            >
                              <text
                                fg={c.text}
                              >{`${bindings.filter(binding => binding.source === exchange.name).length} outgoing routes · ${exchange.auto_delete ? "auto-delete" : "persistent"}`}</text>
                            </box>
                          </box>
                        )
                      })
                    : null}

                  {tab === "bindings"
                    ? currentBindings.map((binding, index) => {
                        const selected = index === clampCursor(cursor, currentBindings.length)
                        const source = binding.source || "(default exchange)"
                        return (
                          <box
                            key={`${binding.source}:${binding.destination}:${binding.properties_key}`}
                            height={2}
                            flexDirection="column"
                            backgroundColor={selected && focused ? c.bgHighlight : undefined}
                          >
                            <box height={1} flexDirection="row">
                              <text fg={selected ? c.warning : c.textMuted} width={2}>
                                {selected ? "▶" : " "}
                              </text>
                              <text fg={c.accent} width={Math.max(8, Math.floor((listWidth - 4) * 0.44))} truncate>
                                {source}
                              </text>
                              <text fg={c.textMuted} width={3}>
                                →
                              </text>
                              <text
                                fg={c.success}
                                width={Math.max(8, listWidth - Math.floor((listWidth - 4) * 0.44) - 10)}
                                truncate
                              >
                                {binding.destination}
                              </text>
                            </box>
                            <box height={1} paddingLeft={2}>
                              <text
                                fg={selected ? c.textBright : c.text}
                                width={Math.max(8, listWidth - 4)}
                                truncate
                              >{`key  ${binding.routing_key || "*"}`}</text>
                            </box>
                          </box>
                        )
                      })
                    : null}

                  {tab === "messages"
                    ? shownMessages.map((message, index) => {
                        const selected = index === clampCursor(messageCursor, shownMessages.length)
                        const preview = payloadPreview(message.payload)
                        const display =
                          preview.length > listWidth - 8 ? `${preview.slice(0, Math.max(0, listWidth - 9))}…` : preview
                        return (
                          <box
                            key={`${message.exchange}:${message.routing_key}:${index}`}
                            height={2}
                            flexDirection="column"
                            backgroundColor={selected && focused ? c.bgHighlight : undefined}
                          >
                            <box
                              height={1}
                              flexDirection="row"
                              backgroundColor={selected && focused ? c.bgHighlight : undefined}
                            >
                              <text fg={selected ? c.warning : c.textMuted} width={2}>
                                {selected ? "▶" : " "}
                              </text>
                              <text fg={message.redelivered ? c.warning : c.success} width={8}>
                                {message.redelivered ? "REPLAY" : "READY"}
                              </text>
                              <text
                                fg={c.info}
                                width={Math.max(12, listWidth - 16)}
                                truncate
                              >{`${message.exchange || "(default)"} → ${message.routing_key || "∅"}`}</text>
                            </box>
                            <box
                              height={1}
                              paddingLeft={3}
                              backgroundColor={selected && focused ? c.bgHighlight : undefined}
                            >
                              <text fg={c.text} truncate>
                                {display}
                              </text>
                            </box>
                          </box>
                        )
                      })
                    : null}

                  {!loading && selectedCount === 0 ? (
                    <box flexGrow={1} alignItems="center" justifyContent="center" paddingY={2}>
                      <text fg={c.textMuted}>
                        {tab === "messages"
                          ? "peek a queue to beam messages into this view"
                          : `no ${tab} in this vhost`}
                      </text>
                    </box>
                  ) : null}
                </box>
              </scrollbox>
            </box>
            {showInspector ? (
              <>
                <box width={1} height="100%">
                  <text fg={c.border}>{"│\n".repeat(100)}</text>
                </box>
                <box flexGrow={1} flexDirection="column" paddingX={2} paddingY={1}>
                  <box height={1} flexDirection="row">
                    <text fg={c.accent}>INSPECTOR</text>
                    <box flexGrow={1} />
                    <text
                      fg={c.text}
                    >{`${selectedCount ? `${clampCursor(tab === "messages" ? messageCursor : cursor, selectedCount) + 1} / ${selectedCount}` : "0 items"}`}</text>
                  </box>
                  <box height={1} />
                  <RabbitInspector
                    tab={tab}
                    queue={selectedQueue}
                    exchange={selectedExchange}
                    binding={selectedBinding}
                    message={selectedMessage}
                    bindings={bindings}
                    width={inspectorWidth}
                    height={height}
                  />
                </box>
              </>
            ) : null}
          </box>
        </>
      )}
    </box>
  )
}

function RabbitInspector({
  tab,
  queue,
  exchange,
  binding,
  message,
  bindings,
  width,
  height,
}: {
  readonly tab: WorkspaceTab
  readonly queue: RabbitQueue | null
  readonly exchange: RabbitExchange | null
  readonly binding: RabbitBinding | null
  readonly message?: RabbitMessage
  readonly bindings: ReadonlyArray<RabbitBinding>
  readonly width: number
  readonly height: number
}) {
  const { colors: c } = useTheme()
  if (
    !(tab === "queues" && queue) &&
    !(tab === "exchanges" && exchange) &&
    !(tab === "bindings" && binding) &&
    !(tab === "messages" && message)
  ) {
    return (
      <box flexGrow={1} flexDirection="column" justifyContent="center" paddingX={1}>
        <text fg={c.textBright}>Nothing selected</text>
        <box height={1} />
        <text fg={c.text}>Use j/k to choose an item. Its details will appear here.</text>
      </box>
    )
  }

  if (tab === "queues" && queue) {
    const kind = queue.type ?? String(queue.arguments?.["x-queue-type"] ?? "classic")
    const args = Object.entries(queue.arguments ?? {})
    return (
      <box flexDirection="column" paddingX={1}>
        <text fg={c.accent}>QUEUE</text>
        <text fg={c.textBright}>{queue.name}</text>
        <text fg={c.text}>{`${kind} · ${queue.durable ? "durable" : "transient"} · ${queue.state ?? "running"}`}</text>
        <box height={1} />
        <DetailField label="Messages" value={(queue.messages ?? 0).toLocaleString()} tone={c.info} />
        <DetailField label="Ready" value={(queue.messages_ready ?? 0).toLocaleString()} tone={c.warning} />
        <DetailField
          label="Unacknowledged"
          value={(queue.messages_unacknowledged ?? 0).toLocaleString()}
          tone={c.info}
        />
        <DetailField label="Consumers" value={(queue.consumers ?? 0).toLocaleString()} tone={c.success} />
        <DetailField label="Auto-delete" value={queue.auto_delete ? "yes" : "no"} />
        <box height={1} />
        <text fg={c.accent}>ARGUMENTS</text>
        {args.length ? (
          args.map(([key, value]) => (
            <text key={key} fg={c.text}>{`${key}  ${typeof value === "string" ? value : JSON.stringify(value)}`}</text>
          ))
        ) : (
          <text fg={c.text}>none</text>
        )}
      </box>
    )
  }

  if (tab === "exchanges" && exchange) {
    const routes = bindings.filter(item => item.source === exchange.name)
    return (
      <box flexDirection="column" paddingX={1}>
        <text fg={c.accent}>EXCHANGE</text>
        <text fg={c.textBright}>{exchange.name}</text>
        <text fg={c.info}>{exchange.type.toUpperCase()}</text>
        <box height={1} />
        <DetailField
          label="Publish rate"
          value={`${(exchange.message_stats?.publish_out_details?.rate ?? 0).toFixed(2)} msg/s`}
          tone={c.success}
        />
        <DetailField label="Outgoing routes" value={routes.length.toLocaleString()} tone={c.info} />
        <DetailField label="Durable" value={exchange.durable ? "yes" : "no"} />
        <DetailField label="Auto-delete" value={exchange.auto_delete ? "yes" : "no"} />
        <DetailField label="Internal" value={exchange.internal ? "yes" : "no"} />
        <box height={1} />
        <text fg={c.accent}>ROUTED TO</text>
        {routes.length ? (
          routes
            .slice(0, 12)
            .map(item => (
              <text
                key={`${item.destination}:${item.properties_key}`}
                fg={c.text}
              >{`${item.destination}  ·  ${item.routing_key || "*"}`}</text>
            ))
        ) : (
          <text fg={c.text}>no queue bindings</text>
        )}
      </box>
    )
  }

  if (tab === "bindings" && binding) {
    const args = Object.entries(binding.arguments ?? {})
    return (
      <box flexDirection="column" paddingX={1}>
        <text fg={c.accent}>BINDING</text>
        <text fg={c.textBright}>{binding.source || "default exchange"}</text>
        <text fg={c.warning}>{`─ ${binding.routing_key || "*"} ─▶`}</text>
        <text fg={c.success}>{binding.destination}</text>
        <box height={1} />
        <DetailField label="Destination" value={binding.destination_type} />
        <DetailField label="Binding id" value={binding.properties_key} />
        <box height={1} />
        <text fg={c.accent}>ARGUMENTS</text>
        {args.length ? (
          args.map(([key, value]) => (
            <text key={key} fg={c.text}>{`${key}  ${typeof value === "string" ? value : JSON.stringify(value)}`}</text>
          ))
        ) : (
          <text fg={c.text}>none</text>
        )}
        {binding.source === "" ? <text fg={c.textMuted}>Default exchange routes are implicit.</text> : null}
      </box>
    )
  }

  if (tab === "messages" && message) {
    const payloadLines = wrapText(payloadDocument(message.payload), Math.max(12, width - 4))
    const visibleLines = payloadLines.slice(0, Math.max(4, height - 21))
    return (
      <box flexDirection="column" paddingX={1} overflow="hidden">
        <text fg={c.accent}>MESSAGE PAYLOAD</text>
        <text fg={c.textBright}>{`${message.exchange || "default exchange"} → ${message.routing_key || "∅"}`}</text>
        <box height={1} />
        <DetailField
          label="State"
          value={message.redelivered ? "redelivered" : "ready"}
          tone={message.redelivered ? c.warning : c.success}
        />
        <DetailField label="Size" value={`${message.payload_bytes ?? message.payload.length} bytes`} />
        <DetailField label="Content type" value={String(message.properties?.content_type ?? "not set")} />
        {message.message_count !== undefined ? (
          <DetailField label="Remaining" value={message.message_count.toLocaleString()} />
        ) : null}
        <box height={1} />
        <text fg={c.accent}>BODY</text>
        {visibleLines.map((line, index) => (
          <text key={index} fg={c.text}>
            {line || " "}
          </text>
        ))}
        {payloadLines.length > visibleLines.length ? (
          <text fg={c.textMuted}>{`… ${payloadLines.length - visibleLines.length} more lines`}</text>
        ) : null}
      </box>
    )
  }

  return <text fg={c.text}>{tab.toUpperCase()}</text>
}

function DetailField({
  label,
  value,
  tone,
}: {
  readonly label: string
  readonly value: string
  readonly tone?: import("@opentui/core").RGBA
}) {
  const { colors: c } = useTheme()
  return (
    <box height={1} flexDirection="row">
      <text fg={c.text} width={16}>
        {label}
      </text>
      <text fg={tone ?? c.textBright} truncate>
        {value}
      </text>
    </box>
  )
}
