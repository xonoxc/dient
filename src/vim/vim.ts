/**
 * Pure Vim-mode state machine. Every transition is a function of the current
 * state plus a single key (or an explicit `VimAction`), so the whole thing can
 * be unit-tested without rendering anything.
 */
import { Option } from "effect"
import type { Selection, SelectionRange, VimAction, VimState } from "@/vim/types"

export const MODE_INSERT = "i" as const
export const MODE_VISUAL = "v" as const
export const MOVE_DOWN = "j" as const
export const MOVE_UP = "k" as const
export const JUMP_FIRST = "g" as const
export const JUMP_LAST = "G" as const

export const ESCAPE_KEYS: readonly string[] = ["escape", "Escape", "\u001b"]

const moveUp: VimAction = { _tag: "Move", direction: "up" }
const moveDown: VimAction = { _tag: "Move", direction: "down" }
const jumpFirst: VimAction = { _tag: "Jump", position: "first" }
const jumpLast: VimAction = { _tag: "Jump", position: "last" }
const enterInsert: VimAction = { _tag: "EnterMode", mode: "insert" }
const toggleVisual: VimAction = { _tag: "ToggleVisual" }
const escape: VimAction = { _tag: "Escape" }

export const initialState = (rowCount = 0): VimState =>
  ({
    mode: "normal",
    cursor: 0,
    selection: Option.none(),
    rowCount: Math.max(0, rowCount),
    pendingG: 0,
  }) as const

export const clampCursor = (rowCount: number, cursor: number): number => {
  if (rowCount <= 0) return 0
  return Math.max(0, Math.min(rowCount - 1, cursor))
}

const enterVisual = (state: VimState): VimState => ({
  ...state,
  mode: "visual",
  selection: Option.some({ anchor: state.cursor, head: state.cursor }),
  pendingG: 0,
})

const withCursor = (state: VimState, cursor: number): VimState => {
  if (state.mode === "visual") {
    return {
      ...state,
      cursor,
      selection: state.selection.pipe(
        Option.map(selection => ({
          ...selection,
          head: cursor,
        }))
      ),
    }
  }
  return { ...state, cursor }
}

export const applyAction = (state: VimState, action: VimAction): VimState => {
  switch (action._tag) {
    case "SetRows": {
      const rowCount = Math.max(0, action.count)
      if (rowCount === state.rowCount) return state
      return {
        ...state,
        rowCount,
        cursor: clampCursor(rowCount, state.cursor),
      }
    }

    case "Move": {
      if (state.mode === "insert") return state
      const delta = action.direction === "up" ? -1 : 1
      const cursor = clampCursor(state.rowCount, state.cursor + delta)
      if (cursor === state.cursor) return state
      return withCursor(state, cursor)
    }

    case "Jump": {
      if (state.mode === "insert") return state
      const cursor = action.position === "first" ? 0 : Math.max(0, state.rowCount - 1)
      if (cursor === state.cursor) return state
      return withCursor(state, cursor)
    }

    case "EnterMode":
      if (action.mode === "insert") {
        if (state.mode === "normal")
          return {
            ...state,
            mode: "insert",
            selection: Option.none(),
          }

        if (state.mode === "visual")
          return {
            ...state,
            mode: "normal",
            selection: Option.none(),
            pendingG: 0,
          }
        return state
      }
      if (action.mode === "normal") {
        if (state.mode === "normal") return state
        return { ...state, mode: "normal", selection: Option.none(), pendingG: 0 }
      }
      if (state.mode === "normal") return enterVisual(state)
      return state

    case "ToggleVisual":
      if (state.mode === "visual")
        return {
          ...state,
          mode: "normal",
          selection: Option.none(),
          pendingG: 0,
        }
      if (state.mode === "normal") return enterVisual(state)
      return state

    case "Escape":
      if (state.mode === "normal") return { ...state, pendingG: 0 }
      return {
        ...state,
        mode: "normal",
        selection: Option.none(),
        pendingG: 0,
      }
  }
}

export const pressKey = (state: VimState, key: string): VimState => {
  if (state.pendingG === 1) {
    if (key === JUMP_FIRST)
      return applyAction(
        {
          ...state,
          pendingG: 0,
        },
        jumpFirst
      )
    return pressKey({ ...state, pendingG: 0 }, key)
  }

  if (key === JUMP_FIRST) return { ...state, pendingG: 1 }

  if (ESCAPE_KEYS.includes(key)) return applyAction(state, escape)

  switch (key) {
    case MODE_INSERT:
      return applyAction(state, enterInsert)
    case MODE_VISUAL:
      return applyAction(state, toggleVisual)
    case MOVE_DOWN:
      return applyAction(state, moveDown)
    case MOVE_UP:
      return applyAction(state, moveUp)
    case JUMP_LAST:
      return applyAction(state, jumpLast)
    default:
      return state
  }
}

export const selectionRange = (selection: Selection): SelectionRange => ({
  start: Math.min(selection.anchor, selection.head),
  end: Math.max(selection.anchor, selection.head),
})

