/**
 * Data table unit tests — the pure surface: `formatCell` value rendering,
 * `rowsWindow` virtualization bounds, and `useTable` cursor/sort/width state
 * (exercised through a small render harness that maps keys to actions).
 */
import { describe, expect, test } from "bun:test"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
import { useKeyboard } from "@opentui/react"
import type { TestRendererSetup } from "@opentui/core/testing"
import { rowsWindow } from "@/table/data-table"
import { formatCell, MIN_COL_WIDTH, MAX_COL_WIDTH, useTable, type UseTableResult } from "@/table/use-table"
import type { ColumnInfo } from "@/drivers/types"

const columns: ReadonlyArray<ColumnInfo> = [
  { name: "id" },
  { name: "name" },
]

describe("formatCell", () => {
  test("null and undefined render as the empty-cell marker", () => {
    expect(formatCell(null)).toBe("∅")
    expect(formatCell(undefined)).toBe("∅")
  })

  test("plain values stringify directly", () => {
    expect(formatCell(42)).toBe("42")
    expect(formatCell("hello")).toBe("hello")
    expect(formatCell(42n)).toBe("42")
    expect(formatCell(true)).toBe("true")
    expect(formatCell(false)).toBe("false")
  })

  test("dates render as ISO strings", () => {
    const date = new Date("2024-01-02T03:04:05Z")
    expect(formatCell(date)).toBe(date.toISOString())
  })

  test("binary blobs render as a byte-size marker", () => {
    expect(formatCell(Uint8Array.from([1, 2, 3]))).toBe("<3 bytes>")
    expect(formatCell(Uint8Array.from([]))).toBe("<0 bytes>")
  })

  test("objects render as JSON", () => {
    expect(formatCell({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}')
  })

  test("unstringifiable objects fall back to String()", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(formatCell(circular)).toBe(String(circular))
  })
})

const many = (count: number): ReadonlyArray<Record<string, unknown>> =>
  Array.from({ length: count }, (_, i) => ({ id: i, name: `row_${i}` }))

describe("rowsWindow", () => {
  test("returns an empty window for an empty table", () => {
    expect(rowsWindow([], 0, 10)).toEqual({ offset: 0, rows: [] })
  })

  test("a list smaller than the viewport is shown whole", () => {
    const rows = many(3)
    expect(rowsWindow(rows, 1, 10)).toEqual({ offset: 0, rows })
  })

  test("the cursor stays centered when possible", () => {
    const rows = many(50)
    const { offset, rows: window } = rowsWindow(rows, 25, 10)
    expect(offset).toBe(20)
    expect(window.map(r => r.id)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29])
  })

  test("the window pins to the top at the first rows", () => {
    const { offset, rows } = rowsWindow(many(50), 1, 10)
    expect(offset).toBe(0)
    expect(rows.map(r => r.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test("the window pins to the bottom at the last rows", () => {
    const { offset, rows } = rowsWindow(many(50), 49, 10)
    expect(offset).toBe(40)
    expect(rows.map(r => r.id)).toEqual([40, 41, 42, 43, 44, 45, 46, 47, 48, 49])
  })

  test("a cursor below the last row clamps to the trailing window", () => {
    const { offset, rows } = rowsWindow(many(20), 0, 30)
    expect(offset).toBe(0)
    expect(rows).toHaveLength(20)
  })
})

describe("useTable", () => {
  test("starts at cursor 0, unsorted, in input order", async () => {
    const setup = await renderTableFixture(columns, unsortedRows)
    try {
      expect(setup.captureCharFrame()).toContain("cursor=0 sort=-:- order=3,1,2")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("j/k move the cursor and clamp at the edges", async () => {
    const setup = await renderTableFixture(columns, unsortedRows)
    try {
      await press(setup, ["j", "j", "j"])
      expect(setup.captureCharFrame()).toContain("cursor=2")
      await press(setup, ["j"])
      expect(setup.captureCharFrame()).toContain("cursor=2")
      await press(setup, ["k", "k"])
      expect(setup.captureCharFrame()).toContain("cursor=0")
      await press(setup, ["k"])
      expect(setup.captureCharFrame()).toContain("cursor=0")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("gg jumps to the first row and G to the last", async () => {
    const setup = await renderTableFixture(columns, many(50))
    try {
      await press(setup, ["G"])
      expect(setup.captureCharFrame()).toContain("cursor=49")
      await press(setup, ["g"])
      expect(setup.captureCharFrame()).toContain("cursor=0")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("sortBy toggles asc, desc, then clears back to input order", async () => {
    const setup = await renderTableFixture(columns, unsortedRows)
    try {
      await press(setup, ["s"])
      expect(setup.captureCharFrame()).toContain("sort=id:asc order=1,2,3")
      await press(setup, ["s"])
      expect(setup.captureCharFrame()).toContain("sort=id:desc order=3,2,1")
      await press(setup, ["s"])
      expect(setup.captureCharFrame()).toContain("sort=-:- order=3,1,2")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("sorting sorts by a different column on first press", async () => {
    const setup = await renderTableFixture(columns, [
      { id: 1, name: "zeta" },
      { id: 2, name: "alpha" },
      { id: 3, name: "mike" },
    ])
    try {
      await press(setup, ["t"])
      expect(setup.captureCharFrame()).toContain("sort=name:asc order=2,3,1")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("empty rows leave the cursor parked at 0 and movement is a no-op", async () => {
    const setup = await renderTableFixture(columns, [])
    try {
      await press(setup, ["j", "j"])
      expect(setup.captureCharFrame()).toContain("cursor=0")
      await press(setup, ["G"])
      expect(setup.captureCharFrame()).toContain("cursor=0")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("column widths floor at MIN_COL_WIDTH and cap at MAX_COL_WIDTH", async () => {
    const cols: ReadonlyArray<ColumnInfo> = [
      { name: "id" },
      { name: "name" },
      { name: "short" },
      { name: "an_extra_long_column_name" },
    ]
    const rows = [
      { id: 1, name: "a", short: "b", "an_extra_long_column_name": "c".repeat(60) },
      { id: 2, name: "b", short: "c", "an_extra_long_column_name": "d" },
    ]
    const setup = await renderTableFixture(cols, rows)
    try {
      const frame = setup.captureCharFrame()
      expect(frame).toContain(
        `widths=id:${MIN_COL_WIDTH},name:4,short:5,an_extra_long_column_name:${MAX_COL_WIDTH}`
      )
    } finally {
      setup.renderer.destroy()
    }
  })

  test("widths sample only the first 100 rows, keeping cost O(1)", async () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({
      id: i,
      name: i < 100 ? "short" : "x".repeat(40),
    }))
    const setup = await renderTableFixture(columns, rows)
    try {
      /* the long value sits past the 100-row sample, so the column stays narrow */
      expect(setup.captureCharFrame()).toContain(`widths=id:${MIN_COL_WIDTH},name:5`)
    } finally {
      setup.renderer.destroy()
    }
  })
})

const unsortedRows: ReadonlyArray<Record<string, unknown>> = [
  { id: 3, name: "carol" },
  { id: 1, name: "alice" },
  { id: 2, name: "bob" },
]

function HookFixture({ table }: { table: UseTableResult }) {
  useKeyboard(e => {
    switch (e.name) {
      case "j":
        table.move(1)
        return
      case "k":
        table.move(-1)
        return
      case "g":
        table.jump("first")
        return
      case "G":
        table.jump("last")
        return
      case "s":
        table.sortBy("id")
        return
      case "t":
        table.sortBy("name")
        return
    }
  })
  return (
    <text truncate>
      {`cursor=${table.cursor} sort=${table.sort?.column ?? "-"}:${table.sort?.dir ?? "-"} order=${table.sortedRows
        .map(r => String(r.id))
        .join(",")} widths=${table.columns.map(c => `${c.name}:${table.widths[c.name]}`).join(",")}`}
    </text>
  )
}

function HookFixtureRoot({
  columns,
  rows,
}: {
  columns: ReadonlyArray<ColumnInfo>
  rows: ReadonlyArray<Record<string, unknown>>
}) {
  const table = useTable(rows, columns)
  return <HookFixture table={table} />
}

async function renderTableFixture(
  columns: ReadonlyArray<ColumnInfo>,
  rows: ReadonlyArray<Record<string, unknown>>
): Promise<TestRendererSetup> {
  const setup = await testRender(
    <HookFixtureRoot columns={columns} rows={rows} />,
    { width: 160, height: 6, kittyKeyboard: true }
  );
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false
  await setup.waitForVisualIdle()
  return setup
}

async function press(setup: TestRendererSetup, keys: ReadonlyArray<string>): Promise<void> {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  try {
    await act(async () => {
      for (const key of keys) {
        setup.mockInput.pressKey(key)
      }
      setup.renderOnce()
      setup.flush()
    })
  } finally {
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false
  }
  await setup.waitForVisualIdle()
}