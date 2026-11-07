/**
 * Installer tests. `install.sh` is plain POSIX shell, so the interesting
 * behavior is platform detection and URL construction. Each test runs the real
 * script in a throwaway directory with fake `uname` / `sysctl` / `curl` ahead
 * of the real PATH: no network, no 130 MB download, and the assertions pin the
 * `dient-<os>-<arch>` asset contract shared with `src/update/check.ts` and
 * `.github/workflows/release.yml`. `install-container.test.ts` is the slow,
 * network-backed counterpart that installs the real published binary.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const INSTALLER = resolve(import.meta.dir, "..", "install.sh")
const REPO = "xonoxc/dient"
const ROOT = mkdtempSync(join(tmpdir(), "dient-install-test-"))

afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

interface Harness {
  readonly root: string
  readonly bin: string
  readonly installDir: string
  readonly downloadLog: string
}

const executable = (path: string, body: string): void => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

/** A throwaway machine: fake platform probes and a fake curl that records URLs. */
const harness = (): Harness => {
  const root = mkdtempSync(join(ROOT, "case-"))
  const bin = join(root, "bin")
  mkdirSync(bin)

  executable(
    join(bin, "uname"),
    `case "$1" in
  -s) printf '%s\\n' "\${FAKE_OS:-Linux}" ;;
  -m) printf '%s\\n' "\${FAKE_ARCH:-x86_64}" ;;
  *) exit 2 ;;
esac`
  )

  executable(join(bin, "sysctl"), `printf '%s\\n' "\${FAKE_SYSCTL_ARM64:-0}"`)

  executable(
    join(bin, "curl"),
    `url=""
dest=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) dest="$2"; shift 2 ;;
    *) url="$1"; shift ;;
  esac
done
[ -n "$dest" ] || exit 2
if [ "\${FAKE_CURL_FAIL:-0}" = "1" ]; then
  exit 22
fi
printf '%s\\n' "$url" > "\${FAKE_CURL_LOG:?}"
printf 'fake dient binary\\n' > "$dest"`
  )

  return {
    root,
    bin,
    installDir: join(root, "install"),
    downloadLog: join(root, "downloaded-url"),
  }
}

const baseEnv = (h: Harness, extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: `${h.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  HOME: h.root,
  DIENT_INSTALL_DIR: h.installDir,
  FAKE_CURL_LOG: h.downloadLog,
  FAKE_OS: "Linux",
  FAKE_ARCH: "x86_64",
  FAKE_SYSCTL_ARM64: "0",
  ...extra,
})

const run = (h: Harness, args: ReadonlyArray<string> = [], extra: Record<string, string> = {}) => {
  const result = spawnSync("/bin/sh", [INSTALLER, ...args], {
    encoding: "utf8",
    env: baseEnv(h, extra),
  })
  if (result.error) throw result.error
  return result
}

const downloadedUrl = (h: Harness): string => readFileSync(h.downloadLog, "utf8").trim()

const installed = (dir: string): string => join(dir, "dient")

const modeOf = (path: string): number => statSync(path).mode & 0o777

describe("install.sh", () => {
  test("is valid POSIX shell syntax", () => {
    const result = spawnSync("/bin/sh", ["-n", INSTALLER], { encoding: "utf8" })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
  })

  test("installs the latest binary for this machine", () => {
    const h = harness()
    const result = run(h)

    expect(result.status).toBe(0)
    expect(downloadedUrl(h)).toBe(`https://github.com/${REPO}/releases/latest/download/dient-linux-x64`)
    expect(readFileSync(installed(h.installDir), "utf8")).toBe("fake dient binary\n")
    expect(modeOf(installed(h.installDir))).toBe(0o755)
    expect(result.stderr).toContain(`Installed dient to ${installed(h.installDir)}`)
    expect(result.stderr).toContain("not on your PATH")
  })

  const platforms = [
    ["Linux", "aarch64", "dient-linux-arm64"],
    ["Linux", "amd64", "dient-linux-x64"],
    ["Darwin", "arm64", "dient-darwin-arm64"],
    ["Darwin", "x86_64", "dient-darwin-x64"],
  ] as const

  for (const [os, arch, asset] of platforms) {
    test(`maps ${os}/${arch} to ${asset}`, () => {
      const h = harness()
      const result = run(h, [], { FAKE_OS: os, FAKE_ARCH: arch })

      expect(result.status).toBe(0)
      expect(downloadedUrl(h)).toBe(`https://github.com/${REPO}/releases/latest/download/${asset}`)
    })
  }

  test("prefers the native arm64 build under Rosetta", () => {
    const h = harness()
    const result = run(h, [], {
      FAKE_OS: "Darwin",
      FAKE_ARCH: "x86_64",
      FAKE_SYSCTL_ARM64: "1",
    })

    expect(result.status).toBe(0)
    expect(downloadedUrl(h)).toBe(`https://github.com/${REPO}/releases/latest/download/dient-darwin-arm64`)
  })

  test("pins a release from --version and DIENT_VERSION", () => {
    const h = harness()

    for (const args of [
      ["--version", "1.2.3"],
      ["--version", "v1.2.3"],
    ]) {
      expect(run(h, args).status).toBe(0)
      expect(downloadedUrl(h)).toBe(`https://github.com/${REPO}/releases/download/v1.2.3/dient-linux-x64`)
    }

    expect(run(h, [], { DIENT_VERSION: "2.0.0" }).status).toBe(0)
    expect(downloadedUrl(h)).toBe(`https://github.com/${REPO}/releases/download/v2.0.0/dient-linux-x64`)

    expect(run(h, ["--version", "latest"]).status).toBe(0)
    expect(downloadedUrl(h)).toBe(`https://github.com/${REPO}/releases/latest/download/dient-linux-x64`)
  })

  test("--dir overrides DIENT_INSTALL_DIR and accepts spaces", () => {
    const h = harness()
    const custom = join(h.root, "custom bin")
    const result = run(h, ["--dir", custom], { DIENT_INSTALL_DIR: join(h.root, "ignored") })

    expect(result.status).toBe(0)
    expect(readFileSync(installed(custom), "utf8")).toBe("fake dient binary\n")
    expect(existsSync(join(h.root, "ignored"))).toBe(false)
  })

  test("omits the PATH hint when the install directory is already on PATH", () => {
    const h = harness()
    const result = run(h, [], {
      PATH: `${h.installDir}:${h.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    })

    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain("not on your PATH")
  })

  test("replaces an existing installation", () => {
    const h = harness()
    mkdirSync(h.installDir, { recursive: true })
    writeFileSync(installed(h.installDir), "old binary", { mode: 0o600 })
    chmodSync(installed(h.installDir), 0o600)

    expect(run(h).status).toBe(0)
    expect(readFileSync(installed(h.installDir), "utf8")).toBe("fake dient binary\n")
    expect(modeOf(installed(h.installDir))).toBe(0o755)
  })

  test("rejects unsupported operating systems and architectures", () => {
    const unsupportedOs = harness()
    const osResult = run(unsupportedOs, [], { FAKE_OS: "FreeBSD" })
    expect(osResult.status).toBe(1)
    expect(osResult.stderr).toContain("unsupported operating system: FreeBSD")

    const unsupportedArch = harness()
    const archResult = run(unsupportedArch, [], { FAKE_ARCH: "riscv64" })
    expect(archResult.status).toBe(1)
    expect(archResult.stderr).toContain("unsupported architecture: riscv64")
  })

  test("reports a failed download and leaves no partial install", () => {
    const h = harness()
    const result = run(h, [], { FAKE_CURL_FAIL: "1" })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("could not download dient-linux-x64")
    expect(result.stderr).toContain(`https://github.com/${REPO}/releases/latest/download/dient-linux-x64`)
    expect(readdirSync(h.installDir)).toEqual([])
  })

  test("requires curl or wget", () => {
    const h = harness()
    const restricted = join(h.root, "restricted")

    /* Keep only the commands the script needs before it reaches the download,
       so `command -v curl` and `command -v wget` both miss. */
    mkdirSync(restricted)
    for (const name of ["uname", "mkdir", "chmod", "mv", "rm"]) {
      const source = name === "uname" ? join(h.bin, name) : Bun.which(name)
      if (!source) throw new Error(`cannot find ${name} on this machine`)
      symlinkSync(source, join(restricted, name))
    }

    const result = run(h, [], { PATH: restricted })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("curl or wget is required")
  })

  test("prints help and rejects bad options", () => {
    const h = harness()

    const help = run(h, ["--help"])
    expect(help.status).toBe(0)
    expect(help.stdout).toContain("Install dient")
    expect(help.stdout).toContain("DIENT_INSTALL_DIR")

    const unknown = run(h, ["--bogus"])
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toContain("unknown option: --bogus")

    const missing = run(h, ["--dir"])
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain("--dir needs a value")
  })

  test("runs when piped through sh -s, as curl | sh does", () => {
    const h = harness()
    const result = spawnSync("/bin/sh", ["-s", "--", "--version", "v3.2.1"], {
      encoding: "utf8",
      env: baseEnv(h),
      input: readFileSync(INSTALLER, "utf8"),
    })

    expect(result.status).toBe(0)
    expect(downloadedUrl(h)).toBe(`https://github.com/${REPO}/releases/download/v3.2.1/dient-linux-x64`)
  })
})
