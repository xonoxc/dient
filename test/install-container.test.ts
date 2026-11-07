/**
 * Real install through the actual GitHub release inside a throwaway Linux
 * container. `install.test.ts` uses fakes to pin platform detection and URL
 * construction cheaply; this test proves the checked-in script can download and
 * install the published binary on a clean glibc system.
 *
 * It is deliberately network-dependent and slow (the binary is ~130 MB): the
 * point is to exercise the same bytes users download. Pin a release with
 * `DIENT_E2E_TAG=v0.0.1` when a moving `latest` is inconvenient.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { GenericContainer, type StartedTestContainer } from "testcontainers"

const INSTALLER = resolve(import.meta.dir, "..", "install.sh")
const INSTALL_DIR = "/tmp/dient-e2e"
const PINNED_TAG = process.env.DIENT_E2E_TAG?.trim()

let container: StartedTestContainer | undefined
let install: { exitCode: number; stdout: string; stderr: string }

beforeAll(async () => {
  container = await new GenericContainer("debian:bookworm-slim")
    .withCommand(["sleep", "infinity"])
    .withStartupTimeout(120_000)
    .withCopyFilesToContainer([{ source: INSTALLER, target: "/tmp/install.sh", mode: 0o755 }])
    .start()

  const setup = await container.exec([
    "sh",
    "-c",
    "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl ca-certificates",
  ])
  if (setup.exitCode !== 0) throw new Error(`container setup failed:\n${setup.stderr}`)

  install = await container.exec(["sh", "/tmp/install.sh"], {
    env: {
      DIENT_INSTALL_DIR: INSTALL_DIR,
      ...(PINNED_TAG ? { DIENT_VERSION: PINNED_TAG } : {}),
    },
  })
}, 300_000)

afterAll(async () => {
  await container?.stop()
}, 120_000)

const exec = async (command: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  if (!container) throw new Error("container is not running")
  return container.exec(command)
}

describe("install.sh against the real release", () => {
  test("downloads and installs the published binary", () => {
    expect(install.exitCode).toBe(0)
    expect(install.stderr).toContain(`Installed dient to ${INSTALL_DIR}/dient`)
    expect(install.stderr).toMatch(/Downloading dient-linux-(x64|arm64)/)
    expect(install.stderr).toContain("not on your PATH")
  })

  test("installs an executable, realistically sized ELF binary", async () => {
    const size = await exec(["stat", "-c", "%s", `${INSTALL_DIR}/dient`])
    expect(size.exitCode).toBe(0)
    expect(Number(size.stdout.trim())).toBeGreaterThan(10_000_000)

    const mode = await exec(["stat", "-c", "%a", `${INSTALL_DIR}/dient`])
    expect(mode.exitCode).toBe(0)
    expect(mode.stdout.trim()).toBe("755")

    const magic = await exec(["od", "-An", "-tx1", "-N4", `${INSTALL_DIR}/dient`])
    expect(magic.exitCode).toBe(0)
    expect(magic.stdout.trim().replace(/\s+/g, " ")).toBe("7f 45 4c 46")
  })

  test("leaves no staging file behind", async () => {
    const listing = await exec(["ls", "-A", INSTALL_DIR])
    expect(listing.exitCode).toBe(0)
    expect(listing.stdout.trim().split("\n")).toEqual(["dient"])
  })
})
