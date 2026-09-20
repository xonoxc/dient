import { describe, expect, test } from "bun:test"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
import type { TestRendererSetup } from "@opentui/core/testing"
import { Option } from "effect"
import { applyAction, initialState, pressKey, selectionRange } from "@/vim/vim"
import { useVimMode } from "@/vim/vim-hook"
import { useKeyboard } from "@opentui/react"
import type { UseVimModeResult } from "@/vim/vim-hook"

describe("vim initial state", () => {
  test("initial mode is NORMAL", () => {
    const state = initialState(10)
    expect(state.mode).toBe("normal")
    expect(state.cursor).toBe(0)
    expect(state.rowCount).toBe(10)
    expect(Option.isNone(state.selection)).toBe(true)
  })

  test("negative row count normalizes to zero", () => {
    expect(initialState(-4).rowCount).toBe(0)
  })
})

describe("vim mode transitions", () => {
  test("i transitions NORMAL to INSERT", () => {
    const state = initialState(10)
    const after = pressKey(state, "i")
    expect(after.mode).toBe("insert")
    expect(Option.isNone(after.selection)).toBe(true)
  })

  test("v transitions NORMAL to VISUAL with a selection anchored at the cursor", () => {
    const state = pressKey(applyAction(initialState(10), { _tag: "Move", direction: "down" }), "v")
    expect(state.mode).toBe("visual")
    const selection = Option.getOrNull(state.selection)
    expect(selection).toEqual({ anchor: 1, head: 1 })
  })

  test("Escape from INSERT returns to NORMAL", () => {
    const state = pressKey(pressKey(initialState(10), "i"), "Escape")
    expect(state.mode).toBe("normal")
  })

  test("Escape from VISUAL returns to NORMAL and clears the selection", () => {
    const afterVisual = pressKey(initialState(10), "v")
    const afterEscape = pressKey(afterVisual, "\u001b")
    expect(afterEscape.mode).toBe("normal")
    expect(Option.isNone(afterEscape.selection)).toBe(true)
  })

  test("Escape in NORMAL is a no-op that clears a pending g chord", () => {
    const pending = pressKey(initialState(10), "g")
    expect(pending.pendingG).toBe(1)
    const after = pressKey(pending, "Escape")
    expect(after.pendingG).toBe(0)
    expect(after.mode).toBe("normal")
  })

  test("pressing v again from VISUAL returns to NORMAL", () => {
    const after = pressKey(pressKey(initialState(10), "v"), "v")
    expect(after.mode).toBe("normal")
    expect(Option.isNone(after.selection)).toBe(true)
  })
})

describe("vim cursor movement", () => {
  test("j moves the cursor down", () => {
    const state = pressKey(initialState(10), "j")
    expect(state.cursor).toBe(1)
  })

  test("k moves the cursor up", () => {
    const state = pressKey(pressKey(initialState(10), "j"), "k")
    expect(state.cursor).toBe(0)
  })

  test("j clamps at the last row (no overflow)", () => {
    const state = pressKey(applyAction(initialState(2), { _tag: "Jump", position: "last" }), "j")
    expect(state.cursor).toBe(1)
  })

  test("k clamps at the first row", () => {
    const state = pressKey(initialState(3), "k")
    expect(state.cursor).toBe(0)
  })

  test("gg jumps to the first row", () => {
    const fromBottom = pressKey(applyAction(initialState(10), { _tag: "Jump", position: "last" }), "g")
    expect(fromBottom.pendingG).toBe(1)
    const state = pressKey(fromBottom, "g")
    expect(state.cursor).toBe(0)
    expect(state.pendingG).toBe(0)
  })

  test("G jumps to the last row", () => {
    const state = pressKey(initialState(10), "G")
    expect(state.cursor).toBe(9)
  })

  test("a stale g prefix is consumed by any other key", () => {
    const pending = pressKey(initialState(10), "g")
    const state = pressKey(pending, "j")
    expect(state.pendingG).toBe(0)
    expect(state.cursor).toBe(1)
  })

  test("ignores movement keys in INSERT mode", () => {
    const insert = pressKey(initialState(10), "i")
    const after = pressKey(insert, "j")
    expect(after.mode).toBe("insert")
    expect(after.cursor).toBe(0)
  })

  test("SetRows clamps the cursor to the new row count", () => {
    const moved = applyAction(initialState(10), { _tag: "Move", direction: "down" })
    const shrunk = applyAction(moved, { _tag: "SetRows", count: 1 })
    expect(shrunk.cursor).toBe(0)
  })
})

describe("vim visual selection", () => {
  test("visual mode tracks the selection range as the cursor moves", () => {
    const state = pressKey(pressKey(pressKey(initialState(10), "v"), "j"), "j")
    expect(Option.isSome(state.selection)).toBe(true)
    const selection = Option.getOrNull(state.selection)
    expect(selection).toEqual({ anchor: 0, head: 2 })
    expect(selectionRange(selection!)).toEqual({ start: 0, end: 2 })
  })

  test("moving back up to the anchor collapses the range", () => {
    const down = pressKey(pressKey(initialState(10), "v"), "j")
    const up = pressKey(down, "k")
    expect(Option.getOrNull(up.selection)).toEqual({ anchor: 0, head: 0 })
  })

  test("jumping to last row extends the selection head", () => {
    const state = pressKey(pressKey(initialState(10), "v"), "G")
    expect(Option.getOrNull(state.selection)).toEqual({ anchor: 0, head: 9 })
  })

  test("editing keys restore NORMAL and drop the selection", () => {
    const after = pressKey(pressKey(initialState(10), "v"), "i")
    expect(after.mode).toBe("normal")
    expect(Option.isNone(after.selection)).toBe(true)
  })
})

describe("useVimMode hook", () => {
  test("starts in NORMAL and follows i/Escape through keyboard events", async () => {
    const setup = await renderVimFixture()
    try {
      expect(setup.captureCharFrame().includes("normal")).toBe(true)

      await actScene(setup, async () => {
        await setup.mockInput.pressKeys(["i"])
      })
      expect(setup.captureCharFrame().includes("insert")).toBe(true)

      await actScene(setup, async () => {
        setup.mockInput.pressEscape()
      })
      expect(setup.captureCharFrame().includes("normal")).toBe(true)
    } finally {
      setup.renderer.destroy()
    }
  })
})

/**
 * The renderer drives React work from its own frame loop, which runs outside
 * React's act() scope, so the act environment is only toggled on around the
 * dispatch that must be flushed and stays off the rest of the time.
 */
async function actScene(setup: TestRendererSetup, scene: () => Promise<void>): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  try {
    await act(async () => {
      await scene()
      await setup.renderOnce()
      await setup.flush()
    })
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  }
  await setup.waitForVisualIdle()
}

/**
 * The hook test drives real key events, and lone ESC bytes only settle into a
 * keypress once the renderer parses a full protocol sequence, so the fixture
 * runs the terminal in kitty keyboard mode like a modern terminal would.
 */
async function renderVimFixture(options: { width?: number; height?: number } = {}): Promise<TestRendererSetup> {
  const setup = await testRender(<HookFixtureRoot />, {
    width: options.width ?? 80,
    height: options.height ?? 24,
    kittyKeyboard: true,
  })
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  await setup.waitForVisualIdle()
  return setup
}

function HookFixture({ mode, cursor, pressKey }: UseVimModeResult) {
  useKeyboard(e => pressKey(e.name))
  /* values are interpolated so a stale frame keeps its last mode text away */
  return <text>{`mode=${mode} cursor=${cursor}`}</text>
}

function HookFixtureRoot() {
  const vim = useVimMode(12)
  return <HookFixture {...vim} />
}
