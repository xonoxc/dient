/**
 * Connection sidebar. Renders the project tree with bang-glyph affordances for
 * expandable rows and a per-connection status dot. The panel itself owns no
 * state — selection lives in `useSidebar`, statuses come from the explorer — so
 * this stays a pure view that is trivial to snapshot.
 */
import { useTheme } from "@/theme-context"
import type { ConnectionId } from "@/domain"
import type { SidebarNode } from "@/sidebar/use-sidebar"
import type { ConnectionStatus } from "@/connection/connection-manager"
import type { VimMode } from "@/vim"
import { fitLabel, SIDEBAR_WIDTH } from "@/sidebar/fit-label"

export interface SidebarProps {
  readonly items: ReadonlyArray<SidebarNode>
  readonly cursor: number
  readonly statuses: Readonly<Record<string, ConnectionStatus>>
  readonly activeConnectionId?: ConnectionId
  readonly focus: boolean
  readonly mode?: VimMode
}

const ENGINE_BADGE: Record<string, string> = { postgres: "PG", mysql: "MY", sqlite: "SQLite" }

/** One space of indent per depth level, so deep tables keep more label room. */
const INDENT_STEP = " "
/** Prefix before a leaf label: the expand glyph and a space. */
const GLYPH = "▸ "

export function Sidebar(props: SidebarProps) {
  const theme = useTheme()
  const c = theme.colors

  if (props.items.length === 0) {
    return (
      <box
        width={SIDEBAR_WIDTH}
        height="100%"
        flexDirection="row"
        overflow="hidden"
      >
        <box flexGrow={1} flexDirection="column" paddingX={1}>
          <box height={1}>
            <text fg={c.textMuted}>PROJECTS</text>
          </box>
          <text fg={c.textMuted}>no projects yet</text>
          <text fg={c.textMuted}>open settings to add one</text>
        </box>
        <box width={1} height="100%">
          <text fg={c.border}>{"│\n".repeat(100)}</text>
        </box>
      </box>
    )
  }

  return (
    <box
      width={SIDEBAR_WIDTH}
      height="100%"
      flexDirection="row"
      overflow="hidden"
    >
      <box flexGrow={1} flexDirection="column" overflow="hidden">
        <box height={1} paddingX={1}>
          <text fg={c.textMuted}>PROJECTS</text>
        </box>
        {props.items.map((node, index) => (
          <SidebarRow key={node.id} node={node} index={index} {...props} />
        ))}
      </box>
      <box width={1} height="100%">
        <text fg={c.border}>{"│\n".repeat(100)}</text>
      </box>
    </box>
  )
}

function SidebarRow({
  node,
  index,
  cursor,
  statuses,
  activeConnectionId,
  focus,
}: {
  node: SidebarNode
  index: number
  cursor: number
  statuses: Readonly<Record<string, ConnectionStatus>>
  activeConnectionId?: ConnectionId
  focus: boolean
}) {
  const theme = useTheme()
  const c = theme.colors
  const selected = index === cursor
  const rowFg = selected ? c.textBright : c.text
  /* Only paint the selection band when this panel owns focus; otherwise the
     bright text alone marks the cursor position without a distracting bar. */
  const rowBg = selected && focus ? c.bgHighlight : undefined

  const indent = INDENT_STEP.repeat(node.depth)

  if (node.kind === "connection") {
    const status = statuses[node.connection!.id] ?? "disconnected"
    const active = activeConnectionId === node.connection!.id
    const dot = status === "connected" ? "●" : status === "error" ? "◉" : "○"
    const dotFg = status === "connected" ? c.success : status === "error" ? c.error : c.textMuted
    const glyph = node.expanded ? "▾" : "▸"
    /* indent + glyph + space + active marker, then dot, space and engine badge. */
    const badge = ENGINE_BADGE[node.database?.engine ?? ""] ?? ""
    const prefix = node.depth * INDENT_STEP.length + 2 + 1 + (active ? 1 : 1) + 1
    return (
      <box height={1} flexDirection="row" paddingX={1} backgroundColor={rowBg}>
        <text fg={rowFg} truncate>
          {indent}
          {glyph} {active ? "▶" : " "}
        </text>
        <text fg={dotFg}>{dot}</text>
        <text fg={rowFg} truncate>
          {" "}
          {fitLabel(node.label, prefix + badge.length)}
        </text>
        <box flexGrow={1} />
        <text fg={c.accentMuted}>{badge}</text>
      </box>
    )
  }

  if (node.kind === "table") {
    return (
      <box height={1} flexDirection="row" paddingX={1} backgroundColor={rowBg}>
        <text fg={rowFg} truncate>
          {indent}
          {GLYPH}
          {fitLabel(node.label, node.depth * INDENT_STEP.length + GLYPH.length)}
        </text>
      </box>
    )
  }

  /* A database row with no connection yet: leaf, no status, muted dot. */
  if (node.kind === "database") {
    return (
      <box height={1} flexDirection="row" paddingX={1} backgroundColor={rowBg}>
        <text fg={rowFg} truncate>
          {indent}○ {fitLabel(node.label, node.depth * INDENT_STEP.length + 2)}
        </text>
        <box flexGrow={1} />
        <text fg={c.textMuted}>{ENGINE_BADGE[node.database?.engine ?? ""] ?? ""}</text>
      </box>
    )
  }

  const glyph = node.expanded ? "▾" : "▸"
  return (
    <box height={1} flexDirection="row" paddingX={1} backgroundColor={rowBg}>
      <text fg={rowFg} truncate>
        {indent}
        {glyph} {fitLabel(node.label, node.depth * INDENT_STEP.length + 2)}
      </text>
    </box>
  )
}
