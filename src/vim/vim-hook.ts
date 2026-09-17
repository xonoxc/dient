/**
 * React adapter over the pure Vim-mode state machine. `useVimMode` owns the
 * mode/cursor/selection state and exposes a key dispatcher plus a row-count
 * sync, so a screen can swap between keyboard-driven and data-driven updates
 * without leaking the state machine internals.
 */
import { useEffect, useReducer } from "react"
import { Option } from "effect"
import { applyAction, initialState, pressKey } from "@/vim/vim"
import type { Selection, VimMode, VimState } from "@/vim/types"

type VimEvent = { readonly _tag: "Key"; readonly key: string } | { readonly _tag: "SetRows"; readonly count: number }

const vimReducer = (state: VimState, event: VimEvent): VimState => {
  switch (event._tag) {
    case "Key":
      return pressKey(state, event.key)
    case "SetRows":
      return applyAction(state, { _tag: "SetRows", count: event.count })
  }
}

export interface UseVimModeResult {
  readonly mode: VimMode
  readonly cursor: number
  readonly selection: Option.Option<Selection>
  readonly pressKey: (key: string) => void
  readonly setRowCount: (count: number) => void
}

export const useVimMode = (rowCount = 0): UseVimModeResult => {
  const [state, dispatch] = useReducer(vimReducer, rowCount, initialState)

  useEffect(() => {
    dispatch({ _tag: "SetRows", count: rowCount })
  }, [rowCount])

  return {
    mode: state.mode,
    cursor: state.cursor,
    selection: state.selection,
    pressKey: (key) => dispatch({ _tag: "Key", key }),
    setRowCount: (count) => dispatch({ _tag: "SetRows", count }),
  }
}