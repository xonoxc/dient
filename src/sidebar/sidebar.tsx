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

export interface SidebarProps {
  readonly items: ReadonlyArray<SidebarNode>
  readonly cursor: number
  readonly statuses: Readonly<Record<string, ConnectionStatus>>
  readonly activeConnectionId?: ConnectionId
  readonly focus: boolean
  readonly mode?: VimMode
}

const ENGINE_BADGE: Record<string, string> = { postgres: "PG", mysql: "MY", sqlite: "SQLite" }

export function Sidebar(props: SidebarProps) {
  const theme = useTheme()
  const c = theme.colors

  if (props.items.length === 0) {
    return (
      <box
        width={26}
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
      width={26}
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

  const indent = "  ".repeat(node.depth)

  if (node.kind === "connection") {
    const status = statuses[node.connection!.id] ?? "disconnected"
    const active = activeConnectionId === node.connection!.id
    const dot = status === "connected" ? "●" : status === "error" ? "◉" : "○"
    const dotFg = status === "connected" ? c.success : status === "error" ? c.error : c.textMuted
    const glyph = node.expanded ? "▾" : "▸"
    return (
      <box height={1} flexDirection="row" paddingX={1} backgroundColor={rowBg}>
        <text fg={rowFg}>
          {indent}
          {glyph} {active ? "▶" : " "}
        </text>
        <text fg={dotFg}>{dot}</text>
        <text fg={rowFg}> {node.label}</text>
        <box flexGrow={1} />
        <text fg={c.accentMuted}>{ENGINE_BADGE[node.database?.engine ?? ""] ?? ""}</text>
      </box>
    )
  }

  if (node.kind === "table") {
    return (
      <box height={1} flexDirection="row" paddingX={1} backgroundColor={rowBg}>
        <text fg={rowFg}>
          {indent}▸ {node.label}
        </text>
      </box>
    )
  }

  /* A database row with no connection yet: leaf, no status, muted dot. */
  if (node.kind === "database") {
    return (
      <box height={1} flexDirection="row" paddingX={1} backgroundColor={rowBg}>
        <text fg={rowFg}>
          {indent}○ {node.label}
        </text>
        <box flexGrow={1} />
        <text fg={c.textMuted}>{ENGINE_BADGE[node.database?.engine ?? ""] ?? ""}</text>
      </box>
    )
  }

  const glyph = node.expanded ? "▾" : "▸"
  return (
    <box height={1} flexDirection="row" paddingX={1} backgroundColor={rowBg}>
      <text fg={rowFg}>
        {indent}
        {glyph} {node.label}
      </text>
    </box>
  )
}
