/**
 * Core types for the Vim-style mode state machine. The state machine itself is
 * pure (no React, no Effect) so it stays trivially testable; the React hook in
 * `vim-hook.ts` is a thin adapter over it.
 */
import { Option } from "effect"

/* The three editing modes a focused list/view can be in. */
export type VimMode = "normal" | "insert" | "visual"

/* Reversed selection: anchor is where VISUAL mode started, head follows the cursor. */
export interface Selection {
  readonly anchor: number
  readonly head: number
}

/* Pure, serializable state of the mode machine. */
export interface VimState {
  readonly mode: VimMode
  readonly cursor: number
  readonly selection: Option.Option<Selection>
  readonly rowCount: number
  readonly pendingG: 0 | 1
}

export type VimDirection = "up" | "down"

export type VimPosition = "first" | "last"

/* Discrete, debounced events a mode machine consumes. */
export type VimAction =
  | { readonly _tag: "Move"; readonly direction: VimDirection }
  | { readonly _tag: "Jump"; readonly position: VimPosition }
  | { readonly _tag: "EnterMode"; readonly mode: VimMode }
  | { readonly _tag: "ToggleVisual" }
  | { readonly _tag: "Escape" }
  | { readonly _tag: "SetRows"; readonly count: number }

/* Normalized view of a selection: `start` <= `end`. */
export interface SelectionRange {
  readonly start: number
  readonly end: number
}

