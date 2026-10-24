/**
 * Connection sidebar. Renders the project tree with bang-glyph affordances for
 * expandable rows and a per-connection status dot. The panel itself owns no
 * state — selection lives in `useSidebar`, statuses come from the explorer — so
 * this stays a pure view that is trivial to snapshot.
 */
import { RGBA } from "@opentui/core"
import { useTheme } from "@/theme-context"
import type { ConnectionId, Engine } from "@/domain"
import type { SidebarNode } from "@/sidebar/use-sidebar"
import type { ConnectionStatus } from "@/connection/connection-manager"
import type { VimMode } from "@/vim"
import type { ThemeColors } from "@/theme"
import { fitLabel, SIDEBAR_WIDTH } from "@/sidebar/fit-label"

export interface SidebarProps {
  readonly items: ReadonlyArray<SidebarNode>
  readonly cursor: number
  readonly statuses: Readonly<Record<string, ConnectionStatus>>
  readonly activeConnectionId?: ConnectionId
  readonly focus: boolean
  /** The pane's number in the screen's left-to-right layout (1-based). */
  readonly paneNumber: number
  readonly mode?: VimMode
}

interface EngineBadge {
  readonly label: string
  readonly tone: keyof ThemeColors
}

const ENGINE_BADGES: Record<Engine, EngineBadge> = {
  postgres: { label: "PG", tone: "accent" },
  mysql: { label: "MYSQL", tone: "warning" },
  sqlite: { label: "SQLite", tone: "info" },
  redis: { label: "Redis", tone: "error" },
}

const engineBadge = (engine: Engine | undefined): EngineBadge | undefined =>
  engine ? ENGINE_BADGES[engine] : undefined

/* Reserve one fixed column for every badge. Right-aligning this block keeps the
   opening bracket on the same vertical line even though labels differ in
   length (`[PG]` is shorter than `[MYSQL]`). */
const ENGINE_BADGE_COLUMN_WIDTH = Math.max(...Object.values(ENGINE_BADGES).map(badge => badge.label.length + 3))

const engineBadgeWidth = (badge: EngineBadge | undefined): number => (badge ? ENGINE_BADGE_COLUMN_WIDTH : 0)

/** One space of indent per depth level, so deep tables keep more label room. */
const INDENT_STEP = " "
/** Prefix before a leaf label: the expand glyph and a space. */
const GLYPH = "▸ "
/** The divider is structural but mixed 80% into the background, so it
    separates without drawing a hard line against the terminal. */
const DIVIDER_ALPHA = 0.8

function SidebarDivider() {
  const c = useTheme().colors
  /* Text foregrounds are painted opaque, so alpha cannot be handed to the
     renderer: bake the 80% mix against the terminal background instead. */
  const divider = RGBA.fromValues(
    c.bg.r + (c.border.r - c.bg.r) * DIVIDER_ALPHA,
    c.bg.g + (c.border.g - c.bg.g) * DIVIDER_ALPHA,
    c.bg.b + (c.border.b - c.bg.b) * DIVIDER_ALPHA
  )
  return (
    <box width={1} height="100%">
      <text fg={divider}>{"│\n".repeat(100)}</text>
    </box>
  )
}

function EngineBadgeText({ badge }: { readonly badge?: EngineBadge }) {
  const theme = useTheme()
  if (!badge) return null
  const text = ` [${badge.label}]`.padEnd(ENGINE_BADGE_COLUMN_WIDTH)
  return <text fg={theme.colors[badge.tone]}>{text}</text>
}

export function Sidebar(props: SidebarProps) {
  const theme = useTheme()
  const c = theme.colors

  if (props.items.length === 0) {
    return (
      <box width={SIDEBAR_WIDTH} height="100%" flexDirection="row" overflow="hidden">
        <box flexGrow={1} flexDirection="column" paddingX={1}>
          <box height={1} flexDirection="row">
            <text fg={props.focus ? c.accent : c.textMuted}>{props.paneNumber} </text>
            <text fg={c.textMuted}>PROJECTS</text>
          </box>
          <text fg={c.textMuted}>no projects yet</text>
          <text fg={c.textMuted}>open settings to add one</text>
        </box>
        <SidebarDivider />
      </box>
    )
  }

  return (
    <box width={SIDEBAR_WIDTH} height="100%" flexDirection="row" overflow="hidden">
      <box flexGrow={1} flexDirection="column" overflow="hidden">
        <box height={1} paddingX={1} flexDirection="row">
          <text fg={props.focus ? c.accent : c.textMuted}>{props.paneNumber} </text>
          <text fg={c.textMuted}>PROJECTS</text>
        </box>
        {props.items.map((node, index) => (
          <SidebarRow key={node.id} node={node} index={index} {...props} />
        ))}
      </box>
      <SidebarDivider />
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
    /* Keep the active marker to one cell so the dot and name stay close. */
    const badge = engineBadge(node.database?.engine)
    const prefix = node.depth * INDENT_STEP.length + 2 + 1 + 1 + 1
    return (
      <box height={1} flexDirection="row" paddingX={1} backgroundColor={rowBg}>
        <text fg={rowFg} truncate>
          {indent}
          {glyph} {active ? "▶" : " "}
        </text>
        <text fg={dotFg}>{dot}</text>
        <text fg={rowFg} truncate>
          {" "}
          {fitLabel(node.label, prefix + engineBadgeWidth(badge))}
        </text>
        <box flexGrow={1} />
        <EngineBadgeText badge={badge} />
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
    const badge = engineBadge(node.database?.engine)
    return (
      <box height={1} flexDirection="row" paddingX={1} backgroundColor={rowBg}>
        <text fg={rowFg} truncate>
          {indent}○ {fitLabel(node.label, node.depth * INDENT_STEP.length + 2 + engineBadgeWidth(badge))}
        </text>
        <box flexGrow={1} />
        <EngineBadgeText badge={badge} />
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
