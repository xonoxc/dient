/**
 * Modal layout tests.
 *
 * The confirm dialog has a fixed 60-column border, and a `<text>` with no
 * wrapping or height cap will happily draw past it. A raw Effect rejection
 * rendered into that body did exactly that, filling the screen with a
 * `FiberFailure` dump and shredding the border. These tests pin the layout
 * invariant: whatever a caller passes, the frame stays a dialog.
 */
import { describe, expect, test } from "bun:test"
import { useEffect } from "react"
import { makeTheme } from "@/theme"
import { ThemeProvider } from "@/theme-context"
import { renderApp } from "@test/support/render-ui"
import { DialogProvider, useDialog, type ConfirmOptions } from "@/app-context"
import { ModalView } from "@/ui/modal"

const BAR = "\u2502"
/* borderStyle="single" renders square corners. */
const CORNER_TOP_LEFT = "\u250c"
const CORNER_TOP_RIGHT = "\u2510"
const CORNER_BOTTOM_LEFT = "\u2514"
const CORNER_BOTTOM_RIGHT = "\u2518"

/** Opens one dialog and holds it open so the frame can be inspected. */
function Opener({ body, title }: { body: string; title?: string }) {
  const { confirm } = useDialog()
  useEffect(() => {
    void confirm({ title: title ?? "are you sure", body, okLabel: "ok" } satisfies ConfirmOptions)
    // Render exactly once: the dialog is the subject of the assertions.
  }, [confirm])
  return null
}

const LONG =
  "Connection \"game_service\" failed: connect ECONNREFUSED 127.0.0.1:3309 " +
  "while opening a very long sentence that will not fit on a single row of a " +
  "sixty column dialog and therefore has to wrap somewhere or escape entirely"

async function frameFor(body: string, title?: string, height?: number) {
  return renderApp(
    <ThemeProvider theme={makeTheme("dark")}>
      <DialogProvider>
        <Opener body={body} title={title} />
        <ModalView />
      </DialogProvider>
    </ThemeProvider>,
    height === undefined ? undefined : { height }
  )
}

describe("modal layout", () => {
  test("a body far wider than the panel wraps instead of spilling", async () => {
    const setup = await frameFor(LONG)
    try {
      const rows = setup.captureCharFrame().split("\n")

      /* Every non-blank row of the dialog is framed, and nothing is drawn to
         the right of the closing bar. This is the assertion that fails when the
         body is a single unwrapped <text>. */
      const framed = rows.filter(row => row.includes(BAR))
      expect(framed.length).toBeGreaterThan(0)
      for (const row of framed) {
        const right = row.lastIndexOf(BAR)
        expect(row.slice(right + 1).trim()).toBe("")
      }

      /* The long text is present, so it wrapped rather than being dropped. */
      const joined = rows.join("\n")
      expect(joined).toContain("ECONNREFUSED")
      expect(joined).toContain("escape entirely")
    } finally {
      setup.renderer.destroy()
    }
  })

  /* Text already wraps horizontally inside a fixed-width box, so an uncapped
     body did not spill sideways — it grew *downward* with every newline until
     the closing border was pushed off screen entirely. The reported failure was
     exactly this shape: a ~19-line rejection dump. */
  test("a multi-line body cannot push the closing border off a short terminal", async () => {
    const DUMP = Array.from({ length: 18 }, (_, i) => `    at frame ${i} (/app/src/drivers/mysql.ts:35:15)`).join(
      "\n"
    )
    const setup = await frameFor(`(FiberFailure) ConnectionError: Failed to connect\n${DUMP}`, undefined, 12)
    try {
      const rows = setup.captureCharFrame().split("\n")
      expect(rows.findIndex(row => row.includes(CORNER_TOP_LEFT) && row.includes(CORNER_TOP_RIGHT))).toBeGreaterThanOrEqual(0)
      expect(rows.some(row => row.includes(CORNER_BOTTOM_LEFT) && row.includes(CORNER_BOTTOM_RIGHT))).toBe(true)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("the border closes on the row below the body, whatever the body says", async () => {
    const setup = await frameFor(LONG)
    try {
      const rows = setup.captureCharFrame().split("\n")
      const top = rows.findIndex(row => row.includes(CORNER_TOP_LEFT) && row.includes(CORNER_TOP_RIGHT))
      const bottom = rows.findIndex(
        (row, i) => i > top && row.includes(CORNER_BOTTOM_LEFT) && row.includes(CORNER_BOTTOM_RIGHT)
      )
      expect(top).toBeGreaterThanOrEqual(0)
      expect(bottom).toBeGreaterThan(top)

      /* Exactly one closed bottom edge, and no stray content below it: an
         uncapped body used to push text past the closing corner. */
      expect(rows.filter(row => row.includes(CORNER_BOTTOM_LEFT)).length).toBe(1)
      for (const row of rows.slice(bottom + 1)) {
        if (row.trim() === "") continue
        expect(row.includes(BAR)).toBe(false)
        expect(row.includes(CORNER_BOTTOM_LEFT)).toBe(false)
      }
    } finally {
      setup.renderer.destroy()
    }
  })

  test("a short body still renders normally", async () => {
    const setup = await frameFor("delete this row?")
    try {
      const frame = setup.captureCharFrame()
      expect(frame).toContain("delete this row?")
      expect(frame).toContain("are you sure")
      expect(frame).toContain("ok")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("a body taller than the cap is clipped, not scrolled off the panel", async () => {
    const setup = await frameFor(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"))
    try {
      const rows = setup.captureCharFrame().split("\n")
      expect(rows.filter(row => row.includes(BAR)).length).toBeLessThan(20)
      /* First line present, last line clipped away — the cap is doing work. */
      expect(rows.join("\n")).toContain("line 0")
      expect(rows.join("\n")).not.toContain("line 39")
    } finally {
      setup.renderer.destroy()
    }
  })
})
