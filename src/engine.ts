/**
 * engine.ts — the mechanics. Runtime-agnostic: runs inside the OpenCode server
 * (the /rundev command and the agent tools), and can be smoke-tested with plain
 * `deno run`.
 *
 * Ownership rule: rundev only stops what rundev started. Anything else is
 * reported, never touched.
 */

import { execFile, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { interruptPanel, probePanel } from "./ghostty.ts"
import {
  composeFiles,
  quoteForTyping,
  readJsonStrict,
  requiresOf,
  serviceCwd,
  type Loaded,
  type Service,
  type Target,
} from "./manifest.ts"

// ────────────────────────────────────────────────────────────── runtime helpers

export interface RunResult {
  code: number
  out: string
  err: string
  timedOut: boolean
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 15_000,
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (err: any, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          out: String(stdout ?? ""),
          err: String(stderr ?? ""),
          timedOut: Boolean(err?.killed),
        })
      },
    )
  })
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Is anything still alive in the process group led by `pid`? A server often
 * outlives its launcher (`pnpm dev` exits, node stays), and then `alive(pid)`
 * says "dead" while the port is still taken.
 */
export function groupAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (err: any) {
    return err?.code === "EPERM"
  }
}

export const procAlive = (pid: number) => alive(pid) || groupAlive(pid)

/** Process group of a pid (to tell "our child holds the port" from "someone else"). */
export async function pgidOf(pid: number): Promise<number | undefined> {
  const r = await run("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { timeoutMs: 3_000 })
  const n = Number(r.out.trim())
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** `xcrun`, overridable so tests (and odd Xcode installs) can point elsewhere. */
export const xcrun = () => process.env.RUNDEV_XCRUN || "/usr/bin/xcrun"
/** `flutter` for the emulator calls: the one on PATH, or `RUNDEV_FLUTTER` (an fvm shim, a custom SDK). */
export const flutterBin = () => process.env.RUNDEV_FLUTTER || "flutter"

let lsofPath: string | undefined
/** `lsof` lives in /usr/sbin on macOS and /usr/bin on most Linux. */
function lsofBin(): string {
  return (lsofPath ??= ["/usr/sbin/lsof", "/usr/bin/lsof"].find((p) => fs.existsSync(p)) ?? "lsof")
}

// ───────────────────────────────────────────────────────────── per-repo lock

const locks = new Map<string, Promise<void>>()

/**
 * Serialises the mutating verbs (`up`, `down`) of one repo. Agents call tools in
 * parallel (`api` and `app@ios` in the same turn); without this both see the
 * service "stopped", both start it, and one process is orphaned.
 */
export async function withLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(root) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const tail = previous.then(() => gate)
  locks.set(root, tail)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (locks.get(root) === tail) locks.delete(root)
  }
}

// ─────────────────────────────────────────────────────────── state + events

export function stateDir(root: string): string {
  return path.join(root, ".opencode", ".rundev")
}

const gitignoreChecked = new Set<string>()

/**
 * Ensures one entry is present in the repo's `.gitignore` (checked once per
 * process). rundev never leaves generated state for the user to ignore by hand.
 */
export function ensureGitignored(root: string, entry: string): boolean {
  const key = `${root}|${entry}`
  if (gitignoreChecked.has(key)) return false
  gitignoreChecked.add(key)
  try {
    if (!fs.existsSync(path.join(root, ".git"))) return false // not a repo: don't litter
    const file = path.join(root, ".gitignore")
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
    const wanted = entry.replace(/\/$/, "")
    const already = current
      .split("\n")
      .map((l) => l.trim())
      .some((l) => l === entry || l === wanted)
    if (already) return false
    const head = current === "" || current.endsWith("\n") ? current : `${current}\n`
    fs.writeFileSync(file, `${head}${entry}\n`)
    return true
  } catch {
    return false
  }
}

export function ensureStateDir(root: string): string {
  const dir = stateDir(root)
  fs.mkdirSync(dir, { recursive: true })
  ensureGitignored(root, ".opencode/.rundev/")
  ensureGitignored(root, ".opencode/rundev.local.json")
  return dir
}

// ─────────────────────────────────────────────────── machine detection

/** Available Android AVDs (`flutter emulators`), best effort. */
export async function detectAvds(): Promise<string[]> {
  const r = await run(flutterBin(), ["emulators"], { timeoutMs: 60_000 })
  const ids = r.out
    .split("\n")
    .filter((l) => l.includes("•"))
    .map((l) => l.split("•")[0]?.trim() ?? "")
    .filter((id) => id && !/^id$/i.test(id))
  return [...new Set(ids)]
}

/** Available iOS simulators (`xcrun simctl list devices available`), best effort. */
export async function detectSimulators(): Promise<string[]> {
  const r = await run(xcrun(), ["simctl", "list", "devices", "available"], { timeoutMs: 60_000 })
  const names = r.out
    .split("\n")
    .map((l) => /^\s+(\S.*?) \([0-9A-Fa-f-]{36}\) \((Booted|Shutdown)\)/.exec(l)?.[1])
    .filter((n): n is string => Boolean(n))
  return [...new Set(names)]
}

// ───────────────────────────────────────────────────────── uninstall

/** Entries rundev may have added to a repo's `.gitignore`. */
export const GITIGNORE_ENTRIES = [".opencode/.rundev/", ".opencode/rundev.local.json", ".opencode/.chrome-profile/"]

export function gitignoreEntriesPresent(root: string): string[] {
  const file = path.join(root, ".gitignore")
  if (!fs.existsSync(file)) return []
  const wanted = new Set(GITIGNORE_ENTRIES.map((e) => e.replace(/\/$/, "")))
  return [
    ...new Set(
      fs
        .readFileSync(file, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && wanted.has(l.replace(/\/$/, ""))),
    ),
  ]
}

/** Removes rundev's own entries from `.gitignore`. Returns what it removed. */
export function removeGitignoreEntries(root: string): string[] {
  const present = gitignoreEntriesPresent(root)
  if (present.length === 0) return []
  const file = path.join(root, ".gitignore")
  const wanted = new Set(GITIGNORE_ENTRIES.map((e) => e.replace(/\/$/, "")))
  const kept = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => {
      const norm = l.trim().replace(/\/$/, "")
      return !(norm && wanted.has(norm))
    })
  const text = kept.join("\n")
  if (text.trim() === "") fs.rmSync(file, { force: true })
  else fs.writeFileSync(file, text)
  return present
}

function humanSize(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function dirSize(dir: string): number {
  let total = 0
  const walk = (d: string) => {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(d, e.name)
      if (e.isDirectory()) walk(abs)
      else {
        try {
          total += fs.statSync(abs).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(dir)
  return total
}

export interface CleanAction {
  what: string
  action: "removed" | "would-remove" | "skipped"
  detail?: string
}

/** Removes everything rundev generated in a repo. Never touches user files. */
export function cleanRepo(loaded: Loaded, opts: { all?: boolean; dryRun?: boolean } = {}): CleanAction[] {
  const rows: CleanAction[] = []
  const act = (what: string, target: string) => {
    if (!fs.existsSync(target)) {
      rows.push({ what, action: "skipped", detail: "not there" })
      return
    }
    let size = 0
    try {
      size = fs.statSync(target).isDirectory() ? dirSize(target) : fs.statSync(target).size
    } catch {
      /* ignore */
    }
    if (opts.dryRun) {
      rows.push({ what, action: "would-remove", detail: humanSize(size) })
      return
    }
    try {
      fs.rmSync(target, { recursive: true, force: true })
      rows.push({ what, action: "removed", detail: humanSize(size) })
    } catch (err) {
      rows.push({ what, action: "skipped", detail: (err as Error).message })
    }
  }

  act("state (.opencode/.rundev)", stateDir(loaded.root))
  for (const [name, svc] of Object.entries(loaded.manifest.services)) {
    if (svc.kind === "browser") act(`chrome profile (${name})`, profileDir(loaded, svc))
  }
  act("machine overrides (.opencode/rundev.local.json)", path.join(loaded.root, ".opencode", "rundev.local.json"))
  if (opts.all) act("manifest (.opencode/rundev.json)", path.join(loaded.root, ".opencode", "rundev.json"))

  const present = gitignoreEntriesPresent(loaded.root)
  if (present.length === 0) {
    rows.push({ what: ".gitignore entries", action: "skipped", detail: "none" })
  } else if (opts.dryRun) {
    rows.push({ what: ".gitignore entries", action: "would-remove", detail: present.join(", ") })
  } else {
    rows.push({ what: ".gitignore entries", action: "removed", detail: removeGitignoreEntries(loaded.root).join(", ") })
  }

  // remove `.opencode/` itself only when it is empty (never your own files)
  const opencodeDir = path.join(loaded.root, ".opencode")
  if (fs.existsSync(opencodeDir) && !opts.dryRun) {
    try {
      fs.rmdirSync(opencodeDir)
      rows.push({ what: ".opencode dir (was empty)", action: "removed" })
    } catch {
      /* not empty: leave it */
    }
  }
  return rows
}

/** Merges machine-specific values into `.opencode/rundev.local.json`. */
export function writeLocalOverrides(root: string, patch: Record<string, unknown>): string {
  const file = path.join(root, ".opencode", "rundev.local.json")
  const read = readJsonStrict(file)
  // A broken local file is somebody's machine settings: never write over it as if it were empty.
  if (read.state === "invalid") throw new Error(`${path.relative(root, file)} is not valid JSON (${read.error}) — fix it first`)
  const current: any = read.state === "ok" && read.value && typeof read.value === "object" ? read.value : {}
  current.services = { ...(current.services ?? {}) }
  for (const [name, svc] of Object.entries((patch.services as Record<string, unknown>) ?? {})) {
    current.services[name] = { ...(current.services[name] ?? {}), ...(svc as object) }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`)
  ensureGitignored(root, ".opencode/rundev.local.json")
  return file
}

export function eventsFile(root: string): string {
  return path.join(stateDir(root), "events.jsonl")
}

export interface RundevEvent {
  /** `event` → toast; `report` → dialog with the full text; `select` → member picker. */
  type: "event" | "report" | "select"
  level?: "info" | "ok" | "warn" | "error"
  service?: string
  message?: string
  title?: string
  text?: string
  /** `select`: verb to run once the members are chosen, and the workspace title. */
  verb?: string
  workspace?: string
  /** `select`: member repo names the workspace offers. */
  members?: string[]
  /** `select`: session that asked, so only its TUI opens the picker. */
  sessionID?: string
  /** Reporter id, so the TUI can group a run. */
  run?: string
  ts?: number
  seq?: number
}

let eventSeq = 0

/** Appends one event line. Never throws: reporting must not break the work. */
export function emit(root: string, ev: RundevEvent): void {
  try {
    ensureStateDir(root)
    fs.appendFileSync(eventsFile(root), `${JSON.stringify({ ...ev, seq: ++eventSeq, ts: Date.now() })}\n`)
  } catch {
    /* ignore */
  }
}

// ────────────────────────────────────────────────────────────── process kind

export interface ProcState {
  name: string
  pid: number
  command: string
  cwd: string
  log: string
  startedAt: number
}

export function readProc(root: string, name: string): ProcState | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(root), `${name}.json`), "utf8"))
  } catch {
    return null
  }
}

// ──────────────────────────────────────────────────────── interactive panels

/**
 * A panel rundev opened in the user's terminal. This marker is written when the
 * panel is launched and forgotten by `down`. With Ghostty's scripting API it also
 * carries the terminal id, so `status` can check that the panel is still there
 * (and still running something); without it, the marker is all the evidence there is.
 *
 * It lives in its own file (`<name>.panel.json`) on purpose: `stopProcess` kills
 * by pidfile, and an interactive panel has no pid — reusing `<name>.json` would
 * feed `process.kill(0, …)` (the whole process group, ours included).
 */
export interface PanelState {
  name: string
  label: string
  command: string
  cwd: string
  /** Target key (`android`, `ios`, …) when the service declares `targets`. */
  target?: string
  /** Ghostty terminal id of the panel (scripting API), when it was opened through it. */
  terminalId?: string
  startedAt: number
}

// ────────────────────────────────────────────── devices rundev booted itself

/**
 * `down` stops what rundev started — and for a device that means the one rundev
 * booted, not "every emulator/simulator that happens to be on": the other
 * project's iPhone is none of its business. The marker is written only when
 * rundev itself boots the device.
 */
export interface DeviceMarker {
  name: string
  kind: "emulator" | "simulator"
  /** adb serial (`emulator-5556`) or simulator udid. */
  id: string
  label: string
  startedAt: number
}

export function deviceFile(root: string, name: string): string {
  return path.join(stateDir(root), `${name}.device.json`)
}

export function readDevice(root: string, name: string): DeviceMarker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(deviceFile(root, name), "utf8"))
    return typeof raw?.id === "string" ? (raw as DeviceMarker) : null
  } catch {
    return null
  }
}

export function writeDevice(root: string, marker: DeviceMarker): void {
  ensureStateDir(root)
  fs.writeFileSync(deviceFile(root, marker.name), JSON.stringify(marker, null, 2))
}

export function clearDevice(root: string, name: string): void {
  fs.rmSync(deviceFile(root, name), { force: true })
}

/** Case-insensitive equality of two optional names (AVD ids, simulator names). */
export const sameName = (a?: string, b?: string): boolean =>
  Boolean(a && b) && (a as string).toLowerCase() === (b as string).toLowerCase()

export function panelFile(root: string, name: string): string {
  return path.join(stateDir(root), `${name}.panel.json`)
}

export function readPanel(root: string, name: string): PanelState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(panelFile(root, name), "utf8"))
    return typeof raw?.startedAt === "number" ? (raw as PanelState) : null
  } catch {
    return null
  }
}

export function writePanel(root: string, name: string, info: Omit<PanelState, "name">): PanelState {
  const state: PanelState = { name, ...info }
  ensureStateDir(root)
  fs.writeFileSync(panelFile(root, name), JSON.stringify(state, null, 2))
  return state
}

/** Forgets the panel. Returns whether there was something to forget. */
export function clearPanel(root: string, name: string): boolean {
  const file = panelFile(root, name)
  if (!fs.existsSync(file)) return false
  fs.rmSync(file, { force: true })
  return true
}

/** `14:32:05 · android` — how a panel marker reads in a status line. */
export function panelWhen(panel: PanelState): string {
  const when = new Date(panel.startedAt).toLocaleTimeString()
  return panel.target ? `${when} · ${panel.target}` : when
}

export function startProcess(root: string, name: string, command: string, cwd: string): ProcState {
  const dir = ensureStateDir(root)
  const log = path.join(dir, `${name}.log`)
  // "w", not "a": each start has its own log, so the "last lines" a failed start
  // reports are this run's and not leftovers of an earlier one.
  const fd = fs.openSync(log, "w")
  // detached + unref + stdio to a file: survives the OpenCode server, and the
  // pidfile is the single source of truth for stopping it.
  const child = spawn("/bin/sh", ["-lc", command], {
    cwd,
    detached: true,
    stdio: ["ignore", fd, fd],
  })
  child.unref()
  fs.closeSync(fd)
  const state: ProcState = { name, pid: child.pid as number, command, cwd, log, startedAt: Date.now() }
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(state, null, 2))
  return state
}

/** SIGTERM to the process group, bounded wait, SIGKILL as last resort. */
export async function stopProcess(
  root: string,
  name: string,
  opts: { killAfterMs?: number; fireAndForget?: boolean; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; detail: string }> {
  const st = readProc(root, name)
  if (!st) return { ok: true, detail: "not started by rundev (nothing to stop)" }
  if (!Number.isInteger(st.pid) || st.pid <= 1) {
    // Defense in depth: pid 0 and negative pids address process *groups*
    // (ours included). A pidfile without a usable pid must never reach kill.
    return { ok: true, detail: "the pidfile has no usable pid (nothing to stop)" }
  }
  // The leader may be gone while its children still serve: look at the group.
  if (!procAlive(st.pid)) return { ok: true, detail: `already dead (pid ${st.pid})` }

  const signal = (sig: "SIGTERM" | "SIGKILL") => {
    try {
      process.kill(-st.pid, sig)
    } catch {
      try {
        process.kill(st.pid, sig)
      } catch {
        /* gone */
      }
    }
  }

  signal("SIGTERM")
  if (opts.fireAndForget) {
    return { ok: true, detail: `stop signal sent to the group (pid ${st.pid})` }
  }
  const deadline = Date.now() + (opts.killAfterMs ?? 4_000)
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return { ok: true, detail: "cancelled while waiting for the process to exit" }
    if (!procAlive(st.pid)) {
      forgetProc(root, name)
      return { ok: true, detail: `stopped (pid ${st.pid})` }
    }
    await sleep(150)
  }
  signal("SIGKILL")
  await sleep(300)
  if (procAlive(st.pid)) return { ok: false, detail: `did not exit (pid ${st.pid}) — check it manually` }
  forgetProc(root, name)
  return { ok: true, detail: `force-stopped (pid ${st.pid})` }
}

/**
 * After a real stop the pidfile is dead weight — and a stale pid is a pid that
 * could be recycled by an unrelated process group. (A pidfile of a process that
 * died on its own stays: "pid N exited" is the clue that it crashed.)
 */
function forgetProc(root: string, name: string): void {
  fs.rmSync(path.join(stateDir(root), `${name}.json`), { force: true })
}

// ──────────────────────────────────────────────────────────────────── ports

export async function portPids(port: number): Promise<number[]> {
  const r = await run(lsofBin(), ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeoutMs: 5_000 })
  return r.out
    .split("\n")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
}

export interface PortCheck {
  port: number
  free: boolean
  /** PIDs listening on the port (empty when free). */
  pids: number[]
  /** Docker containers that publish the port, when what listens is Docker's own proxy. */
  containers?: string[]
}

/** Containers publishing this HOST port (`docker ps --filter publish=`), by name. */
export async function dockerContainersOnPort(port: number): Promise<string[]> {
  const r = await run("docker", ["ps", "--filter", `publish=${port}`, "--format", "{{.Names}}"], { timeoutMs: 6_000 })
  return r.code === 0 ? r.out.split("\n").map((s) => s.trim()).filter(Boolean) : []
}

/**
 * Is this TCP port free to bind? `lsof` is the only portable answer on macOS:
 * a bind attempt would race with the listener and leave a zombie in the panel.
 * When the listener is Docker's own proxy, the pid says nothing (every container
 * is "com.docker.backend"): the container that publishes the port is what to report.
 */
export async function checkPort(port: number): Promise<PortCheck> {
  const pids = await portPids(port)
  if (pids.length === 0) return { port, free: true, pids }
  const names = await Promise.all(
    pids.map(async (pid) => (await run("/bin/ps", ["-o", "comm=", "-p", String(pid)], { timeoutMs: 3_000 })).out.trim()),
  )
  const containers = names.some((n) => /docker/i.test(n)) ? await dockerContainersOnPort(port) : []
  return { port, free: false, pids, ...(containers.length ? { containers } : {}) }
}

/** The port a service listens on: `port`, or the one in its health URL. */
export function listenPort(svc: Service): number | undefined {
  if (svc.port !== undefined) return svc.port
  if (!svc.health) return undefined
  try {
    const parsed = new URL(svc.health)
    const port = Number(parsed.port)
    if (Number.isInteger(port) && port > 0) return port
    return parsed.protocol === "https:" ? 443 : 80
  } catch {
    return undefined
  }
}

/** A port conflict: who holds it and how to inspect it. */
export function portConflictDetail(check: PortCheck): string {
  const who = check.containers?.length
    ? `Docker container ${check.containers.join(", ")} (pid ${check.pids.join(", ")})`
    : check.pids.length
      ? `pid ${check.pids.join(", ")}`
      : "another process"
  const fix = check.containers?.length ? "stop that container (docker stop …)" : "free it, stop it"
  return `port ${check.port} is already in use by ${who} (not started by rundev) — ${fix}, or change the port in the manifest`
}

// ──────────────────────────────────────────────────────────────────── compose

function composeArgs(svc: Service, cmd: string[]): string[] {
  const files = Array.isArray(svc.file) ? svc.file : svc.file ? [svc.file] : []
  return ["compose", ...files.flatMap((f) => ["-f", f]), ...cmd]
}

/**
 * Finds the row of a compose service. The `Service` field is the source of
 * truth; the container name is only a fallback when it matches exactly — a
 * substring match would confuse `app` with `laifapp_mysql`.
 */
export function matchComposeRow(rows: any[], target: string): any | undefined {
  const service = (c: any) => String(c.Service ?? c.service ?? "")
  const name = (c: any) => String(c.Name ?? c.name ?? "")
  return rows.find((c) => service(c) === target) ?? rows.find((c) => name(c) === target)
}

export async function composeState(
  loaded: Loaded,
  name: string,
  svc: Service,
): Promise<{ state: State; detail: string }> {
  const target = svc.service ?? name
  const r = await run("docker", composeArgs(svc, ["ps", "--format", "json"]), {
    cwd: serviceCwd(loaded, svc),
    timeoutMs: 20_000,
  })
  if (r.code !== 0) {
    return { state: "error", detail: firstLine(r.err) || "docker compose ps failed" }
  }
  const rows = r.out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean) as any[]
  const row = matchComposeRow(rows, target)
  if (!row) return { state: "stopped", detail: "container does not exist" }
  const state = String(row.State ?? row.state ?? "")
  const status = String(row.Status ?? row.status ?? state)
  return state.startsWith("running") ? { state: "running", detail: status } : { state: "stopped", detail: status }
}

export async function composeUp(loaded: Loaded, name: string, svc: Service, waitMs: number, signal?: AbortSignal) {
  const target = svc.service ?? name
  const r = await run("docker", composeArgs(svc, ["up", "-d", target]), {
    cwd: serviceCwd(loaded, svc),
    timeoutMs: waitMs,
    signal,
  })
  if (r.code !== 0) return { ok: false, detail: firstLine(r.err) || "docker compose up failed" }
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, detail: "cancelled while waiting for the container" }
    const st = await composeState(loaded, name, svc)
    if (st.state === "running") return { ok: true, detail: st.detail }
    await sleep(700)
  }
  return { ok: true, detail: "starting (not confirmed yet)" }
}

export async function composeStop(loaded: Loaded, name: string, svc: Service) {
  const target = svc.service ?? name
  const r = await run("docker", composeArgs(svc, ["stop", target]), {
    cwd: serviceCwd(loaded, svc),
    timeoutMs: 60_000,
  })
  return r.code === 0
    ? { ok: true, detail: "stopped (container kept)" }
    : { ok: false, detail: firstLine(r.err) || "docker compose stop failed" }
}

// ──────────────────────────────────────────────────────────────────── browser

function profileDir(loaded: Loaded, svc: Service): string {
  return path.resolve(loaded.root, svc.profile ?? ".opencode/.chrome-profile")
}

export async function browserPids(loaded: Loaded, svc: Service): Promise<number[]> {
  const r = await run("/usr/bin/pgrep", ["-f", `user-data-dir=${profileDir(loaded, svc)}`], { timeoutMs: 5_000 })
  return r.out
    .split("\n")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
}

export async function browserUp(loaded: Loaded, name: string, svc: Service) {
  const profile = profileDir(loaded, svc)
  ensureGitignored(loaded.root, `${path.relative(loaded.root, profile)}/`)
  fs.mkdirSync(profile, { recursive: true })
  const url = svc.url ?? `http://localhost:${svc.port}`
  const r = await run(
    "/usr/bin/open",
    ["-na", "Google Chrome", "--args", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", url],
    { timeoutMs: 20_000 },
  )
  return r.code === 0
    ? { ok: true, detail: `opened ${url} (profile ${path.relative(loaded.root, profile)})` }
    : { ok: false, detail: firstLine(r.err) || "could not open Chrome" }
}

export async function browserDown(loaded: Loaded, name: string, svc: Service) {
  const pids = await browserPids(loaded, svc)
  if (pids.length === 0) return { ok: true, detail: "already closed" }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      /* ignore */
    }
  }
  return { ok: true, detail: `closed (${pids.length} process(es))` }
}

// ───────────────────────────────────────────────────────────── .env sections

export interface EnvSectionInfo {
  file: string
  sections: string[]
  active: string | null
}

/** Reads `.env` sections (`# SECTION` headers) and which one is active. */
export function envSections(root: string): EnvSectionInfo | null {
  const file = path.join(root, ".env")
  if (!fs.existsSync(file)) return null
  const lines = fs.readFileSync(file, "utf8").split("\n")
  const sections: string[] = []
  let current: string | null = null
  const activeCount = new Map<string, number>()
  for (const line of lines) {
    const header = /^#\s*([A-Z][A-Z0-9_]*)\s*$/.exec(line.trim())
    if (header) {
      current = header[1]
      if (!sections.includes(current)) sections.push(current)
      continue
    }
    if (/^[A-Z][A-Z0-9_]*=/.test(line) && current) {
      activeCount.set(current, (activeCount.get(current) ?? 0) + 1)
    }
  }
  let active: string | null = null
  let best = 0
  for (const [name, count] of activeCount) {
    if (count > best) {
      best = count
      active = name
    }
  }
  return { file, sections, active }
}

/** Deterministically selects one section (comments the others). Explicit call only. */
export function applyEnvSection(root: string, section: string): { ok: boolean; detail: string } {
  const info = envSections(root)
  if (!info) return { ok: false, detail: "no .env in this repo" }
  if (!info.sections.includes(section)) {
    return { ok: false, detail: `section "${section}" does not exist (found: ${info.sections.join(", ") || "none"})` }
  }
  const lines = fs.readFileSync(info.file, "utf8").split("\n")
  let current: string | null = null
  const out = lines.map((line) => {
    const header = /^#\s*([A-Z][A-Z0-9_]*)\s*$/.exec(line.trim())
    if (header) {
      current = header[1]
      return `# ${current}`
    }
    const commented = /^#\s*([A-Z][A-Z0-9_]*)=/.exec(line)
    const plain = /^([A-Z][A-Z0-9_]*)=/.exec(line)
    if (current && current !== section) {
      if (plain) return `# ${line.trim()}`
      if (commented) return `# ${commented[1]}=${line.split("=").slice(1).join("=").trim()}`
    }
    if (current === section) {
      if (commented) return `${commented[1]}=${line.split("=").slice(1).join("=").trim()}`
    }
    return line
  })
  fs.writeFileSync(info.file, out.join("\n"))
  return { ok: true, detail: `section ${section} enabled in .env` }
}

// ───────────────────────────────────────────────── emulator / simulator

export interface AndroidDevice {
  serial: string
  /** AVD name, when `adb emu avd name` answers. */
  avd?: string
}

export async function adbDevicesFull(): Promise<AndroidDevice[]> {
  const r = await run("adb", ["devices"], { timeoutMs: 15_000 })
  const serials = r.out
    .split("\n")
    .slice(1)
    .map((l) => l.split("\t")[0]?.trim() ?? "")
    .filter((s) => s.startsWith("emulator-"))
  const out: AndroidDevice[] = []
  for (const serial of serials) {
    const avd = await run("adb", ["-s", serial, "emu", "avd", "name"], { timeoutMs: 5_000 })
    const name = avd.code === 0 ? avd.out.split("\n")[0]?.trim() : ""
    out.push({ serial, avd: name && name !== "OK" ? name : undefined })
  }
  return out
}

async function adbDevices(): Promise<string[]> {
  return (await adbDevicesFull()).map((d) => d.serial)
}

/**
 * The connected emulator that is the declared AVD. When adb cannot name the AVD
 * (old platform-tools) and exactly one emulator is connected, that one is it.
 */
export function matchEmulator(devices: AndroidDevice[], avd?: string): AndroidDevice | undefined {
  if (!avd) return devices[0]
  return devices.find((d) => sameName(d.avd, avd)) ?? (devices.length === 1 && !devices[0].avd ? devices[0] : undefined)
}

export async function emulatorState(svc: Service): Promise<{ state: State; detail: string }> {
  const devices = await adbDevicesFull()
  if (devices.length === 0) return { state: "stopped", detail: "no emulator connected" }
  const declared = svc.avd
  const match = matchEmulator(devices, declared)
  if (match) return { state: "running", detail: `${declared ?? match.serial} (${match.serial})` }
  const seen = devices.map((d) => (d.avd ? `${d.avd} (${d.serial})` : d.serial)).join(", ")
  return { state: "stopped", detail: `connected: ${seen} — none is ${declared}` }
}

/** Launches the AVD and waits (bounded) until Android reports boot completed. */
export async function emulatorUp(
  loaded: Loaded,
  name: string,
  svc: Service,
  emitEv: (ev: RundevEvent) => void,
  signal?: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
  const avd = svc.avd
  if (!avd) return { ok: false, detail: "emulator service without `avd`" }
  const already = matchEmulator(await adbDevicesFull(), avd)
  if (already) return { ok: true, detail: `already connected (${already.serial}) — not started by rundev, so \`down\` leaves it` }

  const log = path.join(ensureStateDir(loaded.root), `${name}.log`)
  const fd = fs.openSync(log, "a")
  const child = spawn("/bin/sh", ["-lc", `${quoteForTyping(flutterBin()) ?? flutterBin()} emulators --launch ${quoteForTyping(avd) ?? avd}`], {
    detached: true,
    stdio: ["ignore", fd, fd],
  })
  child.unref()
  fs.closeSync(fd)
  emitEv({ type: "event", level: "info", service: name, message: `launching AVD ${avd}…` })

  // Serials already connected before the launch: the new one is the one that is not here.
  const before = new Set((await adbDevicesFull()).map((d) => d.serial))
  const waitMs = svc.waitMs ?? 180_000
  const deadline = Date.now() + waitMs
  let serial: string | null = null
  while (Date.now() < deadline && !serial) {
    if (signal?.aborted) return { ok: false, detail: "cancelled while waiting for the emulator" }
    const devices = await adbDevicesFull()
    serial = (matchEmulator(devices, avd) ?? devices.find((d) => !before.has(d.serial)))?.serial ?? null
    if (!serial) await sleep(1_000)
  }
  if (!serial) {
    return { ok: false, detail: `AVD ${avd} did not appear in \`adb devices\` within ${waitMs / 1000}s — check the emulator window` }
  }
  // rundev booted this one: `down` may stop it (and only it).
  writeDevice(loaded.root, { name, kind: "emulator", id: serial, label: avd, startedAt: Date.now() })
  emitEv({ type: "event", level: "info", service: name, message: `${serial} connected · waiting for boot…` })

  let ticks = 0
  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, detail: "cancelled while waiting for the boot" }
    const r = await run("adb", ["-s", serial, "shell", "getprop", "sys.boot_completed"], { timeoutMs: 10_000 })
    if (r.out.trim() === "1") return { ok: true, detail: `${serial} booted (${avd})` }
    if (++ticks % 5 === 0) {
      emitEv({ type: "event", level: "info", service: name, message: `still booting ${serial}…` })
    }
    await sleep(2_000)
  }
  return { ok: false, detail: `${serial} did not finish booting within the wait — it usually finishes on its own` }
}

/**
 * Fire-and-forget by design: the emulator may save a quick-boot snapshot while closing.
 * Only the emulator rundev booted for this service goes down — never "every emulator".
 */
export async function emulatorDown(loaded: Loaded, name: string, svc: Service): Promise<{ ok: boolean; detail: string }> {
  const devices = await adbDevicesFull()
  const marker = readDevice(loaded.root, name)
  if (!marker) {
    const running = matchEmulator(devices, svc.avd)
    return running
      ? { ok: true, detail: `${running.serial} was not started by rundev — left running` }
      : { ok: true, detail: "already off" }
  }
  clearDevice(loaded.root, name)
  // the serial must still be the same AVD (serials are recycled between boots)
  const target = devices.find((d) => d.serial === marker.id && (!d.avd || !svc.avd || sameName(d.avd, svc.avd)))
  if (!target) return { ok: true, detail: "already off" }
  const child = spawn("/usr/bin/env", ["adb", "-s", target.serial, "emu", "kill"], { detached: true, stdio: "ignore" })
  child.unref()
  return { ok: true, detail: `kill order sent to ${target.serial} (it may take a few seconds to close)` }
}

export interface SimulatorDevice {
  name: string
  udid: string
}

/** The booted simulator that is the declared one (by name or udid, any case). */
export function matchSimulator(booted: SimulatorDevice[], declared?: string): SimulatorDevice | undefined {
  if (!declared) return booted[0]
  return booted.find((s) => sameName(s.name, declared) || sameName(s.udid, declared))
}

/**
 * Candidate UI apps that display simulators, in preference order.
 *
 * Xcode 27 replaced `Simulator.app` with **DeviceHub** (`com.apple.dt.Devices`),
 * and DeviceHub lives **inside the Xcode bundle** (`Contents/Applications`), not
 * in `/Applications` — so `open -a Simulator` fails on those machines.
 */
export function simulatorUiCandidates(devDir?: string): string[] {
  const out: string[] = []
  if (devDir) {
    out.push(path.resolve(devDir, "..", "Applications", "DeviceHub.app"))
    out.push(path.join(devDir, "Applications", "Simulator.app"))
    out.push(
      path.join(devDir, "Platforms", "iPhoneSimulator.platform", "Developer", "Applications", "Simulator.app"),
    )
  }
  out.push("/Applications/DeviceHub.app", "/Applications/Simulator.app")
  return out
}

export interface SimulatorUi {
  /** Absolute app path, when it is on disk. */
  path?: string
  /** `DeviceHub` or `Simulator`, for the report. */
  name: string
  /** LaunchServices bundle id, used when no path was found. */
  bundleID: string
}

/** Finds the app that shows simulators: DeviceHub (Xcode 27+) or Simulator (older). */
export async function simulatorUiApp(): Promise<SimulatorUi> {
  const dev = (await run("/usr/bin/xcode-select", ["-p"], { timeoutMs: 5_000 })).out.trim()
  for (const candidate of simulatorUiCandidates(dev || undefined)) {
    if (fs.existsSync(candidate)) {
      const name = path.basename(candidate, ".app")
      const bundleID = name === "DeviceHub" ? "com.apple.dt.Devices" : "com.apple.iphonesimulator"
      return { path: candidate, name, bundleID }
    }
  }
  // Nothing on disk: let LaunchServices find it (Xcode beta, custom installs).
  return { name: "DeviceHub", bundleID: "com.apple.dt.Devices" }
}

/** Opens (or activates) the simulator UI, whichever app this Xcode ships. */
export function openSimulatorUi(ui: SimulatorUi) {
  const args = ui.path ? [ui.path] : ["-b", ui.bundleID]
  const child = spawn("/usr/bin/open", args, { detached: true, stdio: "ignore" })
  child.on("error", () => {}) // no `open` (not macOS): nothing to reveal
  child.unref()
}

export async function bootedSimulatorsFull(): Promise<SimulatorDevice[]> {
  const r = await run(xcrun(), ["simctl", "list", "devices", "booted"], { timeoutMs: 30_000 })
  const out: SimulatorDevice[] = []
  for (const line of r.out.split("\n")) {
    if (!line.includes("(Booted)")) continue
    const m = /^\s*(.+?)\s*\(([0-9A-Fa-f-]{36})\)\s*\(Booted\)/.exec(line)
    if (m) out.push({ name: m[1].trim(), udid: m[2] })
  }
  return out
}

async function bootedSimulators(): Promise<string[]> {
  return (await bootedSimulatorsFull()).map((s) => s.name)
}

export async function simulatorState(svc: Service): Promise<{ state: State; detail: string }> {
  const booted = await bootedSimulatorsFull()
  if (booted.length === 0) return { state: "stopped", detail: "no simulator booted" }
  const declared = svc.device
  const match = matchSimulator(booted, declared)
  if (match) return { state: "running", detail: `${match.name} (${match.udid})` }
  return {
    state: "stopped",
    detail: `booted: ${booted.map((s) => s.name).join(", ")} — none is ${declared}`,
  }
}

export async function simulatorUp(
  loaded: Loaded,
  name: string,
  svc: Service,
  emitEv: (ev: RundevEvent) => void,
  signal?: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
  const device = svc.device
  if (!device) return { ok: false, detail: "simulator service without `device`" }
  const booted = await bootedSimulatorsFull()
  const already = matchSimulator(booted, device)
  if (already) {
    // A booted device can be headless: bring the UI to the front too.
    const ui = await simulatorUiApp()
    openSimulatorUi(ui)
    return { ok: true, detail: `already booted (${already.name}) · ${ui.name} — not started by rundev, so \`down\` leaves it` }
  }

  emitEv({ type: "event", level: "info", service: name, message: `booting ${device}…` })
  const boot = await run(xcrun(), ["simctl", "boot", device], { timeoutMs: 90_000, signal })
  if (boot.code !== 0 && !/current state: Booted/i.test(boot.err)) {
    // The usual cause is a name from another machine in rundev.local.json: say which ones exist HERE.
    const available = /invalid device/i.test(boot.err) ? await detectSimulators() : []
    return {
      ok: false,
      detail:
        `simctl boot "${device}" failed: ${firstLine(boot.err) || `exit ${boot.code}`}` +
        (available.length
          ? ` — simulators available here: ${available.slice(0, 10).join(", ")}. Fix \`device\` in .opencode/rundev.local.json`
          : ""),
    }
  }
  // Xcode 27: DeviceHub. Older Xcode: Simulator.app. Never assume the name.
  const ui = await simulatorUiApp()
  openSimulatorUi(ui)

  const waitMs = svc.waitMs ?? 90_000
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, detail: "cancelled while waiting for the simulator" }
    const match = matchSimulator(await bootedSimulatorsFull(), device)
    if (match) {
      // rundev booted this one: `down` may shut it down (and only it).
      writeDevice(loaded.root, { name, kind: "simulator", id: match.udid, label: match.name, startedAt: Date.now() })
      return { ok: true, detail: `${match.name} booted · ${ui.name}` }
    }
    await sleep(1_500)
  }
  return { ok: false, detail: `${device} did not boot within ${waitMs / 1000}s` }
}

/** Shuts down the simulator rundev booted for this service — never "every booted simulator". */
export async function simulatorDown(loaded: Loaded, name: string, svc: Service): Promise<{ ok: boolean; detail: string }> {
  const booted = await bootedSimulatorsFull()
  const marker = readDevice(loaded.root, name)
  if (!marker) {
    const running = matchSimulator(booted, svc.device)
    return running
      ? { ok: true, detail: `${running.name} was not started by rundev — left running` }
      : { ok: true, detail: "already shut down" }
  }
  clearDevice(loaded.root, name)
  const target = booted.find((s) => sameName(s.udid, marker.id))
  if (!target) return { ok: true, detail: "already shut down" }
  const child = spawn(xcrun(), ["simctl", "shutdown", target.udid], { detached: true, stdio: "ignore" })
  child.unref()
  return { ok: true, detail: `shutdown order sent to ${target.name}` }
}

// ─────────────────────────────────────────────────────── session timeline

/** Writes the report where `cat` can pick it up for the session timeline. */
export function writeReport(root: string, text: string): string {
  const file = path.join(ensureStateDir(root), "last-report.txt")
  try {
    fs.writeFileSync(file, text)
  } catch {
    /* ignore */
  }
  return file
}

/**
 * Mirrors the report into the session timeline as a shell message (`!cat …`),
 * so it stays in the history and the model reads it as context — without
 * triggering a turn, which is what `synthetic` would do.
 */
export function pushToTimeline(sessionID: string | undefined, root: string, text: string): void {
  if (!sessionID || process.env.RUNDEV_NO_TIMELINE) return
  const file = writeReport(root, text)
  const quoted = quoteForTyping(file) ?? file
  const body = JSON.stringify({ command: `cat ${quoted}` })
  try {
    const child = spawn("opencode", ["api", "post", `/api/session/${sessionID}/shell`, "--data", body], {
      detached: true,
      stdio: "ignore",
    })
    // A missing binary is an 'error' EVENT, not an exception: unhandled, it takes the process down.
    child.on("error", () => {})
    child.unref()
  } catch {
    /* the dialog already showed it: never fail because of the mirror */
  }
}

// ──────────────────────────────────────────────────────────────────── status

export type State = "running" | "stopped" | "starting" | "external" | "unhealthy" | "unknown" | "error"

export interface ServiceStatus {
  name: string
  kind: Service["kind"]
  state: State
  detail: string
  port?: number
  pid?: number
  /** Extra data for the report, e.g. which processes hold the port. */
  holders?: number[]
}

async function checkCommand(loaded: Loaded, svc: Service, target?: Target): Promise<boolean | null> {
  const check = target?.check ?? svc.check
  if (check) {
    const r = await run("/bin/sh", ["-lc", check], { cwd: serviceCwd(loaded, svc), timeoutMs: 10_000 })
    return r.code === 0
  }
  if (svc.health) {
    const r = await run("/usr/bin/curl", ["-sf", "-o", "/dev/null", "--max-time", "4", svc.health], { timeoutMs: 8_000 })
    return r.code === 0
  }
  return null
}

/**
 * Bounded wait for an interactive service's declared `check`/`health` to pass,
 * right after the panel was opened. `null` means neither the service nor its
 * active target declares one, so there is nothing to verify against.
 */
export async function verifyInteractive(
  loaded: Loaded,
  name: string,
  targetName?: string,
  waitMs = 30_000,
  signal?: AbortSignal,
): Promise<boolean | null> {
  const svc = loaded.manifest.services[name]
  if (!svc) return null
  const target = targetName && svc.targets ? svc.targets[targetName] : undefined
  if (!(target?.check ?? svc.check ?? svc.health)) return null
  const deadline = Date.now() + Math.max(1_000, waitMs)
  for (;;) {
    if (signal?.aborted) return null
    if ((await checkCommand(loaded, svc, target)) === true) return true
    if (Date.now() >= deadline) return false
    await sleep(700)
  }
}

export async function statusOf(loaded: Loaded, name: string): Promise<ServiceStatus> {
  const svc = loaded.manifest.services[name]
  if (!svc) return { name, kind: "process", state: "error", detail: "not in the manifest" }

  const base: ServiceStatus = { name, kind: svc.kind, state: "unknown", detail: "", port: listenPort(svc) }

  if (svc.kind === "compose") {
    const st = await composeState(loaded, name, svc)
    return { ...base, state: st.state, detail: st.detail }
  }

  if (svc.kind === "emulator") {
    const st = await emulatorState(svc)
    return { ...base, state: st.state, detail: st.detail }
  }

  if (svc.kind === "simulator") {
    const st = await simulatorState(svc)
    return { ...base, state: st.state, detail: st.detail }
  }

  if (svc.kind === "browser") {
    const pids = await browserPids(loaded, svc)
    return pids.length
      ? { ...base, state: "running", detail: `Chrome with the project profile (${pids.length} proc)`, pid: pids[0] }
      : { ...base, state: "stopped", detail: "closed" }
  }

  if (svc.kind === "process") {
    const st = readProc(loaded.root, name)
    if (st && procAlive(st.pid)) {
      const ready = await checkCommand(loaded, svc)
      const leader = alive(st.pid)
      const who = leader ? `pid ${st.pid}` : `pid ${st.pid} (the launcher exited, its children are still running)`
      if (ready === false) {
        // A server that is still booting is not an unhealthy one: restarting it
        // on the next `up` would kill it before it ever answers.
        const age = Date.now() - st.startedAt
        if (age < (svc.waitMs ?? STARTING_GRACE_MS)) {
          return {
            ...base,
            state: "starting",
            detail: `booting for ${Math.round(age / 1000)}s (${who}) — not answering its check yet`,
            pid: st.pid,
          }
        }
        return { ...base, state: "unhealthy", detail: `alive but the check fails (${who})`, pid: st.pid }
      }
      return { ...base, state: "running", detail: who, pid: st.pid }
    }
    const holders = base.port !== undefined ? await portPids(base.port) : []
    if (holders.length) {
      const healthy = await checkCommand(loaded, svc)
      return {
        ...base,
        state: "external",
        detail:
          `port ${base.port} held by pid ${holders.join(", ")}, not started by rundev` +
          (healthy === true ? " · its health check passes" : healthy === false ? " · and it does not pass the health check" : ""),
        holders,
      }
    }
    return { ...base, state: "stopped", detail: st ? `pid ${st.pid} exited` : "not started by rundev" }
  }

  // interactive: verified with `check`/`health` when the manifest declares one
  // (per target, when the service declares `targets`). Without one, the only
  // evidence rundev has is the marker it wrote when it opened the panel — hence
  // the honest "assumed open" wording.
  const panel = readPanel(loaded.root, name)
  const activeTarget = svc.targets
    ? svc.targets[panel?.target ?? svc.defaultTarget ?? Object.keys(svc.targets)[0]]
    : undefined
  const verdict = await checkCommand(loaded, svc, activeTarget)
  if (verdict === false) {
    // The check fails, but the panel is alive and running something: it is
    // still building (flutter takes minutes), not gone. Opening another panel
    // on top of it is exactly what must not happen.
    const probe = panel?.terminalId ? await probePanel(panel.terminalId) : null
    if (panel && probe?.exists && !probe.idle && Date.now() - panel.startedAt < (svc.waitMs ?? STARTING_PANEL_MS)) {
      return {
        ...base,
        state: "starting",
        detail: `panel launched ${panelWhen(panel)} is running ${probe.command} · its check does not pass yet (still building?)`,
      }
    }
    return {
      ...base,
      state: "stopped",
      detail: panel
        ? `the panel launched ${panelWhen(panel)} is gone (the check fails)`
        : "the check fails and no panel was launched by rundev",
    }
  }
  if (verdict === true) {
    return {
      ...base,
      state: "running",
      detail: panel
        ? `panel launched ${panelWhen(panel)} · the check passes`
        : "the check passes (no panel launched by rundev)",
    }
  }
  if (panel) {
    // Opened through Ghostty's scripting API: the terminal itself can be asked.
    const probe = panel.terminalId ? await probePanel(panel.terminalId) : null
    const settling = Date.now() - panel.startedAt < PANEL_SETTLE_MS
    if (probe && !probe.exists) {
      return { ...base, state: "stopped", detail: `the panel launched ${panelWhen(panel)} was closed` }
    }
    if (probe?.exists && probe.idle && !settling) {
      return {
        ...base,
        state: "stopped",
        detail: `the panel launched ${panelWhen(panel)} is back at a shell prompt: the command ended`,
      }
    }
    if (probe?.exists) {
      return {
        ...base,
        state: "running",
        detail: `panel launched ${panelWhen(panel)} · open, running ${probe.idle ? "its shell (starting)" : probe.command}`,
      }
    }
    return {
      ...base,
      state: "running",
      detail: `panel launched ${panelWhen(panel)} · assumed open (no check declared, terminal not inspectable)`,
    }
  }
  return { ...base, state: "unknown", detail: "no panel launched by rundev and no check declared to tell" }
}

/** How long a freshly started server may take before "not answering" means "unhealthy". */
const STARTING_GRACE_MS = 60_000
/** A just-opened panel is still at its shell prompt for a moment: that is not "ended". */
const PANEL_SETTLE_MS = 8_000
/** How long a running panel whose check does not pass yet is "still building". */
const STARTING_PANEL_MS = 300_000

export async function statusAll(loaded: Loaded): Promise<ServiceStatus[]> {
  const list = await Promise.all(Object.keys(loaded.manifest.services).map((n) => statusOf(loaded, n)))
  writeSnapshot(loaded, list)
  return list
}

// ─────────────────────────────────────────────────────────────── snapshot

/** Compact status the TUI sidebar renders (and any client can read). */
export interface Snapshot {
  ts: number
  root: string
  services: Array<{
    name: string
    kind: Service["kind"]
    state: State
    detail: string
    port?: number
    pid?: number
  }>
}

export function snapshotFile(root: string): string {
  return path.join(stateDir(root), "status.json")
}

export function writeSnapshot(loaded: Loaded, list: ServiceStatus[]): void {
  try {
    ensureStateDir(loaded.root)
    const snapshot: Snapshot = {
      ts: Date.now(),
      root: loaded.root,
      services: list.map(({ name, kind, state, detail, port, pid }) => ({ name, kind, state, detail, port, pid })),
    }
    fs.writeFileSync(snapshotFile(loaded.root), JSON.stringify(snapshot, null, 2))
  } catch {
    /* reporting must never break the work */
  }
}

export function readSnapshot(root: string): Snapshot | null {
  try {
    return JSON.parse(fs.readFileSync(snapshotFile(root), "utf8"))
  } catch {
    return null
  }
}

// ───────────────────────────────────────────────────────────────── up / down

export interface LaunchPlan {
  name: string
  label: string
  command: string
  cwd: string
  target?: string
  /** Device the launch will target (`-d`), resolved from the target/requires. */
  device?: string
  /** Where the device came from, for the report (`target.device`, `` `simulator` ``). */
  deviceSource?: string
  /** The target declares a device that is not up: flutter will have to choose. */
  deviceWarning?: string
  envSection?: string
  envWarning?: string
}

export interface UpResult {
  name: string
  /**
   * `starting`: the process is alive and booting, not ready yet — it is NOT a
   * failure and running `up` again will not speed it up (it waits, never restarts).
   */
  action: "started" | "already" | "starting" | "blocked" | "manual" | "failed" | "stopped" | "planned"
  detail: string
  pid?: number
}

export interface LaunchResult {
  ok: boolean
  detail: string
  /** Nothing was started: the command is on the clipboard for the person to run. */
  manual?: boolean
  /** The panel is open and running, but its check has not passed yet (still building). */
  starting?: boolean
  /** Ghostty terminal id of the panel, to check later that it is still there. */
  terminalId?: string
}

export interface UpOptions {
  /** Bounded wait for readiness (ms). 0 = fire and report. */
  waitMs?: number
  /** Relaunch what is already up (`--force`), panels included. */
  force?: boolean
  /** Launcher for interactive services (the plugin wires the terminal here). */
  launch?: (plan: LaunchPlan) => Promise<LaunchResult>
  /** `app` → `ios`: which target to launch per interactive service. */
  targets?: Record<string, string>
  /** Report what would happen (ports, deps, commands) without starting anything. */
  dryRun?: boolean
  /** Switch the `.env` section a target requires instead of blocking. Explicit. */
  switchEnv?: boolean
  /** Cancels the bounded waits when the session stops the tool. */
  signal?: AbortSignal
  onEvent?: (ev: RundevEvent) => void
  /**
   * Services already tried earlier in this same invocation (e.g. a device warmed up
   * in parallel with the repo it waits for). A failed one is not tried again.
   */
  attempted?: Map<string, UpResult>
}

/** Resolves a target for an interactive service: `app@ios`, `app`, → Target. */
export function resolveTarget(svc: Service, target?: string): { name: string; target: Target } | null {
  if (!svc.targets) return null
  const name = target ?? svc.defaultTarget ?? Object.keys(svc.targets)[0]
  const t = svc.targets[name]
  return t ? { name, target: t } : null
}

/** Adds `-d <device>` to a `flutter run` that has not decided its device yet. */
export function flutterDeviceFlag(command: string, device?: string): string {
  if (!device) return command
  if (/(^|\s)(-d|--device-id)(\s|=)/.test(command)) return command
  if (/(^|\s|\/)flutter(\.bat)?\s+run(\s|$)/.test(command)) return `${command} -d ${device}`
  return command
}

/** A real device id (serial / udid / flutter platform id), not a placeholder. */
export function isDeviceId(value: string): boolean {
  if (/^emulator-\d+$/.test(value)) return true
  if (/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(value)) return true
  return /^(chrome|chrome-device|macos|linux|windows|web-server)$/i.test(value)
}

/** `device: "emulator"` / `"simulator"` are platform hints written by old scans, not ids. */
export function isPlaceholderDevice(value: string): boolean {
  return /^(emulator|simulator|device|android|ios|mobile)$/i.test(value)
}

/**
 * Which device a launch will land on. `target.device` used to be decorative:
 * `flutter run` with an emulator and a simulator booted asks (or picks at
 * random). The device is now resolved and passed as `-d`.
 */
export async function resolveDevice(
  loaded: Loaded,
  svc: Service,
  resolved: { name: string; target: Target } | null,
): Promise<{ device?: string; source?: string; warning?: string }> {
  const raw = resolved?.target.device
  const declared = raw && !isPlaceholderDevice(raw) ? raw : undefined
  const name = (resolved?.name ?? "").toLowerCase()
  const needs = requiresOf(svc, resolved?.name).map((dep) => loaded.manifest.services[dep]).filter(Boolean) as Service[]
  const emu = needs.find((s) => s.kind === "emulator")
  const sim = needs.find((s) => s.kind === "simulator")
  const wantsSimulator = Boolean(sim) || name.includes("ios")
  const wantsEmulator = Boolean(emu) || name.includes("android")

  // A pinned id is honoured when it is real. Serials are NOT stable between
  // boots (emulator-5554 today, -5556 tomorrow): a stale pin must not send the
  // app to whatever emulator now owns that serial.
  if (declared && /^emulator-\d+$/.test(declared)) {
    if ((await adbDevicesFull()).some((d) => d.serial === declared)) return { device: declared, source: "target.device" }
  } else if (declared && isDeviceId(declared)) {
    return { device: declared, source: "target.device" }
  }

  if (wantsSimulator) {
    const booted = await bootedSimulatorsFull()
    const want = declared && !isDeviceId(declared) ? declared : sim?.device
    if (want) {
      const match = matchSimulator(booted, want)
      if (match) return { device: match.udid, source: `simulator ${match.name}` }
      return { warning: `simulator "${want}" is not booted: flutter will have to choose a device` }
    }
    if (booted.length === 1) return { device: booted[0].udid, source: "the only booted simulator" }
  }
  if (wantsEmulator) {
    const devices = await adbDevicesFull()
    const want = declared && !isDeviceId(declared) ? declared : emu?.avd
    if (want) {
      const match = matchEmulator(devices, want)
      if (match) return { device: match.serial, source: `AVD ${want}` }
      return { warning: `emulator "${want}" is not connected: flutter will have to choose a device` }
    }
    if (devices.length === 1) return { device: devices[0].serial, source: "the only connected emulator" }
  }
  return {}
}

export async function launchPlan(
  loaded: Loaded,
  name: string,
  svc: Service,
  targetName?: string,
): Promise<LaunchPlan | { error: string }> {
  const cwd = serviceCwd(loaded, svc)
  const resolved = svc.targets ? resolveTarget(svc, targetName) : null
  if (svc.targets && !resolved) {
    return {
      error:
        `target "${targetName}" does not exist for ${name} ` +
        `(declared: ${Object.keys(svc.targets).join(", ") || "none"})`,
    }
  }
  const base = resolved?.target.launch ?? svc.up
  if (!base) return { error: `${name}: no launch command` }
  const { device, source, warning } = await resolveDevice(loaded, svc, resolved)
  const command = flutterDeviceFlag(base, device)

  let envWarning: string | undefined
  const section = resolved?.target.envSection
  if (section) {
    const info = envSections(cwd)
    if (info && info.sections.length > 0 && info.active !== section) {
      envWarning =
        `the .env has section ${info.active ?? "(none)"} active and this target needs ${section} — ` +
        `switch it with \`/rundev env ${section}\`, or run up again with switchEnv (\`--switch-env\`) to do it for you`
    }
  }
  const label = `${path.basename(cwd)}${resolved ? ` · ${resolved.name}` : ""}${device ? ` · ${device}` : ""}`
  return {
    name,
    label,
    command,
    cwd,
    target: resolved?.name,
    device,
    deviceSource: source,
    deviceWarning: warning,
    envSection: section,
    envWarning,
  }
}

/**
 * Puts what each service needs before it (emulator → app, api → web → browser):
 * its own `requires` plus its active target's. Dependencies first, once each.
 */
export function expandRequires(loaded: Loaded, names: string[], targets: Record<string, string> = {}): string[] {
  const out: string[] = []
  const visiting = new Set<string>()
  const visit = (name: string) => {
    if (out.includes(name) || visiting.has(name)) return
    visiting.add(name) // a cycle never loops: validate() reports it
    const svc = loaded.manifest.services[name]
    if (svc) {
      const resolved = svc.targets ? resolveTarget(svc, targets[name]) : null
      for (const dep of requiresOf(svc, resolved?.name)) visit(dep)
    }
    visiting.delete(name)
    if (!out.includes(name)) out.push(name)
  }
  for (const name of names) visit(name)
  return out
}

/** Every service the manifest declares (what a bare `down` stops). */
export function allSet(loaded: Loaded): string[] {
  return Object.keys(loaded.manifest.services)
}

/**
 * Waits (bounded) until a process answers its `check`/`health`. A service with
 * neither is "ready" the moment it is started: there is nothing to ask it.
 */
async function waitReady(loaded: Loaded, svc: Service, waitMs: number, signal?: AbortSignal): Promise<boolean> {
  if (waitMs <= 0) return true
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (signal?.aborted) return false
    const ok = await checkCommand(loaded, svc)
    if (ok !== false) return true // true = answers; null = nothing to verify against
    await sleep(500)
  }
  return false
}

export async function up(loaded: Loaded, names: string[], opts: UpOptions = {}): Promise<UpResult[]> {
  // A plan changes nothing, so it never has to queue behind a real `up`.
  if (opts.dryRun) return upLocked(loaded, names, opts)
  return withLock(loaded.root, () => upLocked(loaded, names, opts))
}

async function upLocked(loaded: Loaded, names: string[], opts: UpOptions): Promise<UpResult[]> {
  const emitEv = (ev: RundevEvent) => {
    emit(loaded.root, ev)
    opts.onEvent?.(ev)
  }
  emitEv({ type: "event", level: "info", message: `${opts.dryRun ? "plan: " : ""}up: ${names.join(", ")}` })

  // Dependencies first. Then by LEVEL: what does not depend on each other starts at
  // the same time (the emulator boots while the database and the api come up), and a
  // service waits only for the things it really requires.
  const order = expandRequires(loaded, names, opts.targets)
  const needs = (name: string) =>
    requiresOf(loaded.manifest.services[name], opts.targets?.[name]).filter((dep) => order.includes(dep))
  const level = new Map<string, number>()
  for (const name of order) level.set(name, 1 + Math.max(-1, ...needs(name).map((dep) => level.get(dep) ?? 0)))
  const levels: string[][] = []
  for (const name of order) (levels[level.get(name) as number] ??= []).push(name)

  const results = new Map<string, UpResult>()
  const planned: string[] = []

  const upService = async (name: string): Promise<UpResult> => {
    if (opts.signal?.aborted) return { name, action: "failed", detail: "cancelled" }
    // Already tried (and failed) earlier in this same run — e.g. a device warmed up
    // in parallel: do not boot it a second time.
    const prior = opts.attempted?.get(name)
    if (prior && (prior.action === "failed" || prior.action === "blocked")) return prior
    const svc = loaded.manifest.services[name]
    if (!svc) return { name, action: "failed", detail: "not in the manifest" }

    // A service never starts on top of a requirement that failed: the app does not
    // launch against an emulator that did not boot, nor web against a dead api.
    const broken = needs(name)
      .map((dep) => results.get(dep))
      .find((r) => r && (r.action === "failed" || r.action === "blocked"))
    if (broken) {
      const detail = `requires ${broken.name}, which ${broken.action === "failed" ? "failed" : "is blocked"}: ${firstLine(broken.detail)} — fix that first`
      emitEv({ type: "event", level: "warn", service: name, message: detail })
      return { name, action: "blocked", detail }
    }

    const st = await statusOf(loaded, name)
    const wanted = svc.targets ? resolveTarget(svc, opts.targets?.[name])?.name : undefined
    const panel = svc.kind === "interactive" ? readPanel(loaded.root, name) : null
    // An explicit `app@ios` over a panel opened for `android` is a real request:
    // relaunch there instead of answering "already up".
    const retarget = Boolean(wanted && panel?.target && panel.target !== wanted)
    const force = Boolean(opts.force) || retarget
    if (st.state === "starting" && !force) {
      // Still booting (a previous `up` timed out, or an agent retried): wait for
      // it. Restarting here would kill it before it ever answers, forever.
      if (opts.dryRun) {
        planned.push(name)
        return { name, action: "planned", detail: `still starting (${st.detail}) — would wait for it, not restart it` }
      }
      const ready =
        svc.kind === "interactive"
          ? (await verifyInteractive(loaded, name, panel?.target, opts.waitMs ?? 10_000, opts.signal)) !== false
          : await waitReady(loaded, svc, opts.waitMs ?? 10_000, opts.signal)
      if (ready) {
        emitEv({ type: "event", level: "ok", service: name, message: `ready (${st.detail})` })
        return { name, action: "already", detail: "ready — it was still booting", pid: st.pid }
      }
      const detail = `still starting (${st.detail}) — give it a few more seconds and check rundev_status/rundev_logs; do not start it again`
      emitEv({ type: "event", level: "warn", service: name, message: detail })
      return { name, action: "starting", detail, pid: st.pid }
    }
    if (st.state === "external") {
      // Somebody else already runs it. If it answers its health check, the job
      // is done (dependents can go on); only a deaf listener is a real conflict.
      if ((await checkCommand(loaded, svc)) === true) {
        const detail = `${st.detail} — healthy, so it is used as is`
        emitEv({ type: "event", level: "ok", service: name, message: `already up · ${detail}` })
        return { name, action: "already", detail }
      }
    }
    if (st.state === "unhealthy") {
      // alive but not serving: recover it (we own the pidfile, so a restart is safe)
      emitEv({ type: "event", level: "warn", service: name, message: "alive but unhealthy → restarting" })
      if (!opts.dryRun) await stopProcess(loaded.root, name, { signal: opts.signal })
    } else if ((st.state === "running" || st.state === "starting") && force) {
      // Relaunch the same service (the launch itself forgets the old panel).
      emitEv({
        type: "event",
        level: "warn",
        service: name,
        message: retarget ? `open for ${panel?.target} → switching to ${wanted}` : "already up → relaunching (--force)",
      })
      if (svc.kind === "process" && !opts.dryRun) await stopProcess(loaded.root, name, { signal: opts.signal })
    } else if (st.state === "running") {
      let detail = st.detail
      // A booted simulator can be headless (DeviceHub closed): reveal it.
      if (svc.kind === "simulator" && !opts.dryRun) {
        const ui = await simulatorUiApp()
        openSimulatorUi(ui)
        detail = `${detail} · ${ui.name}`
      }
      emitEv({ type: "event", level: "ok", service: name, message: `already up · ${detail}` })
      return { name, action: "already", detail }
    }

    // ── preflight: a port that is already taken is never a good start
    // (browsers do not listen; devices have no port of their own).
    const servicePort = svc.kind === "browser" ? undefined : listenPort(svc)
    if (servicePort !== undefined) {
      const check = await checkPort(servicePort)
      // Our own process (force/restart, or a dry run of one) still holds it: the
      // listener is a child of the launcher, so look at its process group.
      let ours = false
      if (st.pid !== undefined && !check.free) {
        const groups = await Promise.all(check.pids.map(pgidOf))
        ours = check.pids.includes(st.pid) || groups.includes(st.pid)
      }
      if (!check.free && !ours) {
        const detail = portConflictDetail(check)
        emitEv({ type: "event", level: "error", service: name, message: detail })
        return { name, action: "blocked", detail }
      }
    }

    if (opts.dryRun) {
      const line = await planLine(loaded, name, svc, opts, planned)
      planned.push(name)
      return { name, action: "planned", detail: line }
    }

    if (svc.kind === "compose") {
      emitEv({ type: "event", level: "info", service: name, message: "starting container…" })
      const r = await composeUp(loaded, name, svc, opts.waitMs ?? 60_000, opts.signal)
      emitEv({ type: "event", level: r.ok ? "ok" : "error", service: name, message: r.detail })
      return { name, action: r.ok ? "started" : "failed", detail: r.detail }
    }

    if (svc.kind === "process") {
      const st2 = startProcess(loaded.root, name, svc.up as string, serviceCwd(loaded, svc))
      emitEv({ type: "event", level: "info", service: name, message: `starting · pid ${st2.pid}` })
      const wantsCheck = Boolean(svc.check || svc.health)
      const waitMs = opts.waitMs ?? 10_000
      let ready = await waitReady(loaded, svc, waitMs, opts.signal)
      if (ready && !wantsCheck && waitMs > 0) {
        // Nothing to ask it, so the only evidence is that it is still there: a
        // command that dies at once (`deno: command not found`) must not be "started".
        await sleep(400)
        ready = procAlive(st2.pid)
      }
      if (ready) {
        const detail = wantsCheck && waitMs > 0 ? `pid ${st2.pid} · ready` : `pid ${st2.pid}`
        emitEv({ type: "event", level: "ok", service: name, message: detail })
        return { name, action: "started", detail, pid: st2.pid }
      }
      // Not answering yet. Dead is a failure; alive is "still starting" — and the
      // difference matters: an agent that reads "failed" runs it again.
      const tail = (await logs(loaded, name, 6)).trim()
      if (procAlive(st2.pid)) {
        const detail =
          `pid ${st2.pid} · alive, not answering its ${svc.check ? "check" : "health URL"} after ${Math.round(waitMs / 1000)}s ` +
          `— still starting; check rundev_status / rundev_logs in a few seconds, do not start it again. Last log lines:\n${tail || "(no output yet)"}`
        emitEv({ type: "event", level: "warn", service: name, message: detail.split("\n")[0] })
        return { name, action: "starting", detail, pid: st2.pid }
      }
      const detail = `pid ${st2.pid} · exited before it was ready — last log lines:\n${tail || "(no output)"}`
      emitEv({ type: "event", level: "error", service: name, message: detail.split("\n")[0] })
      return { name, action: "failed", detail, pid: st2.pid }
    }

    if (svc.kind === "browser") {
      const r = await browserUp(loaded, name, svc)
      emitEv({ type: "event", level: r.ok ? "ok" : "error", service: name, message: r.detail })
      return { name, action: r.ok ? "started" : "failed", detail: r.detail }
    }

    if (svc.kind === "emulator") {
      const r = await emulatorUp(loaded, name, svc, emitEv, opts.signal)
      emitEv({ type: "event", level: r.ok ? "ok" : "error", service: name, message: r.detail })
      return { name, action: r.ok ? "started" : "failed", detail: r.detail }
    }

    if (svc.kind === "simulator") {
      const r = await simulatorUp(loaded, name, svc, emitEv, opts.signal)
      emitEv({ type: "event", level: r.ok ? "ok" : "error", service: name, message: r.detail })
      return { name, action: r.ok ? "started" : "failed", detail: r.detail }
    }

    // interactive → the launcher decides (terminal panel or manual command)
    let plan = await launchPlan(loaded, name, svc, opts.targets?.[name])
    if ("error" in plan) return { name, action: "failed", detail: plan.error }
    if (plan.envWarning && opts.switchEnv && plan.envSection) {
      const before = envSections(plan.cwd)?.active ?? "none"
      const switched = applyEnvSection(plan.cwd, plan.envSection)
      emitEv({
        type: "event",
        level: switched.ok ? "ok" : "warn",
        service: name,
        message: switched.ok ? `switched .env ${before} → ${plan.envSection}` : switched.detail,
      })
      if (switched.ok) plan = await launchPlan(loaded, name, svc, opts.targets?.[name])
    }
    if ("error" in plan) return { name, action: "failed", detail: plan.error }
    if (plan.envWarning) {
      emitEv({ type: "event", level: "warn", service: name, message: plan.envWarning })
      return { name, action: "blocked", detail: plan.envWarning }
    }
    if (!opts.launch) return { name, action: "manual", detail: plan.command }
    // A fresh launch supersedes whatever was recorded — and a failed one leaves
    // no marker behind, so the next `up` is allowed to retry. Panels open one at
    // a time: two splits racing for the same terminal would shuffle the layout.
    clearPanel(loaded.root, name)
    const launch = opts.launch
    const r = await withLock(`${loaded.root}#panels`, () => launch(plan as LaunchPlan))
    if (r.ok && r.manual) {
      // Nothing was started (no scriptable terminal): the command is on the
      // clipboard. No marker either — the next `up` must offer it again.
      emitEv({ type: "event", level: "warn", service: name, message: r.detail })
      return { name, action: "manual", detail: r.detail }
    }
    if (r.ok) {
      // Remember the panel: it is what makes a second `up` idempotent.
      writePanel(loaded.root, name, {
        label: plan.label,
        command: plan.command,
        cwd: plan.cwd,
        target: plan.target,
        terminalId: r.terminalId,
        startedAt: Date.now(),
      })
    }
    emitEv({ type: "event", level: r.ok ? (r.starting ? "warn" : "ok") : "warn", service: name, message: r.detail })
    return { name, action: r.ok ? (r.starting ? "starting" : "started") : "failed", detail: r.detail }
  }

  for (const group of levels) {
    if (!group) continue
    const done = await Promise.all(group.map(upService))
    group.forEach((name, i) => results.set(name, done[i]))
  }

  if (!opts.dryRun) await statusAll(loaded) // refresh the snapshot: the sidebar must not go stale
  return order.map((name) => results.get(name) as UpResult)
}

/** One line describing what `up` would do for this service (dry run). */
async function planLine(loaded: Loaded, name: string, svc: Service, opts: UpOptions, planned: string[] = []): Promise<string> {
  if (svc.kind === "compose") {
    const port = listenPort(svc) !== undefined ? ` · host port ${listenPort(svc)} free` : ""
    return `would run docker compose up -d ${svc.service ?? name}${port}`
  }
  if (svc.kind === "process") {
    const port = listenPort(svc) !== undefined ? ` · port ${listenPort(svc)} free` : ""
    return `would run \`${svc.up}\` in ${path.relative(loaded.root, serviceCwd(loaded, svc)) || "."}${port}`
  }
  if (svc.kind === "browser") return `would open Chrome · ${svc.url ?? `http://localhost:${svc.port}`}`
  if (svc.kind === "emulator") return `would launch AVD ${svc.avd} (wait up to ${(svc.waitMs ?? 180_000) / 1000}s)`
  if (svc.kind === "simulator") return `would boot ${svc.device} (wait up to ${(svc.waitMs ?? 90_000) / 1000}s)`
  const plan = await launchPlan(loaded, name, svc, opts.targets?.[name])
  if ("error" in plan) return `would fail: ${plan.error}`
  const dev = plan.device ? ` · device ${plan.device}${plan.deviceSource ? ` (${plan.deviceSource})` : ""}` : ""
  // A device this same run is about to boot cannot be resolved yet: that is the plan, not a problem.
  const booting = requiresOf(svc, plan.target).filter((dep) => planned.includes(dep))
  const warn = plan.deviceWarning
    ? booting.length
      ? ` · -d <device> is added once ${booting.join(", ")} is up`
      : ` · ${plan.deviceWarning}`
    : ""
  const env = plan.envWarning ? ` · BLOCKED: ${plan.envWarning}` : ""
  return `would open a panel${plan.target ? ` [${plan.target}]` : ""}: ${plan.command}${dev}${warn}${env}`
}

export interface DownOptions {
  /** Also close the panel once what ran in it has ended (never while something still runs). */
  closePanel?: boolean
}

export async function down(loaded: Loaded, names: string[], opts: DownOptions = {}): Promise<UpResult[]> {
  return withLock(loaded.root, () => downLocked(loaded, names, opts))
}

async function downLocked(loaded: Loaded, names: string[], opts: DownOptions): Promise<UpResult[]> {
  const results: UpResult[] = []
  const emitEv = (ev: RundevEvent) => emit(loaded.root, ev)
  emitEv({ type: "event", level: "info", message: `down: ${names.join(", ")}` })

  for (const name of names) {
    const svc = loaded.manifest.services[name]
    if (!svc) {
      results.push({ name, action: "failed", detail: "not in the manifest" })
      continue
    }
    let r: { ok: boolean; detail: string }
    if (svc.kind === "compose") r = await composeStop(loaded, name, svc)
    else if (svc.kind === "process") {
      r = await stopProcess(loaded.root, name, { fireAndForget: svc.stopMode === "fire-and-forget" })
    } else if (svc.kind === "browser") r = await browserDown(loaded, name, svc)
    else if (svc.kind === "emulator") r = await emulatorDown(loaded, name, svc)
    else if (svc.kind === "simulator") r = await simulatorDown(loaded, name, svc)
    else {
      // interactive: rundev never owns the panel, it only forgets it — so the
      // next `up` is allowed to open a new one.
      const panel = readPanel(loaded.root, name)
      const known = clearPanel(loaded.root, name)
      if (!known) {
        r = { ok: true, detail: "the panel is yours: close it with ctrl+C" }
      } else if (!panel?.terminalId) {
        // opened without the scripting API: nothing can be asked of it
        r = { ok: true, detail: "forgotten (close it with ctrl+C if it is still open)" }
      } else {
        // The panel is ours (we opened it, by id): stop what runs in it. Ctrl+C goes to
        // THAT terminal, and only while something other than a shell prompt is running.
        const res = await interruptPanel(panel.terminalId, { close: opts.closePanel })
        const closed = res.closed ? " and closed it" : ""
        r =
          res.state === "stopped"
            ? { ok: true, detail: `stopped ${res.command ?? "it"} in its panel (ctrl+C)${closed}` }
            : res.state === "idle"
              ? { ok: true, detail: `its panel was already at a prompt: nothing to stop${closed}` }
              : res.state === "gone"
                ? { ok: true, detail: "its panel was already closed" }
                : res.state === "still-running"
                  ? { ok: false, detail: `ctrl+C did not end ${res.command ?? "it"} in its panel — press ctrl+C there` }
                  : { ok: true, detail: "forgotten (Ghostty could not be asked: ctrl+C in the panel if it is still open)" }
      }
    }

    emitEv({ type: "event", level: r.ok ? "ok" : "warn", service: name, message: r.detail })
    results.push({ name, action: r.ok ? "stopped" : "failed", detail: r.detail })
  }
  await statusAll(loaded) // refresh the snapshot: the sidebar must not go stale
  return results
}

// ───────────────────────────────────────────────────────────────────── logs

export async function logs(loaded: Loaded, name: string, tail = 40): Promise<string> {
  const svc = loaded.manifest.services[name]
  if (!svc) return `not in the manifest`
  if (svc.kind === "process" || svc.kind === "interactive") {
    const st = readProc(loaded.root, name)
    const file = st?.log ?? path.join(stateDir(loaded.root), `${name}.log`)
    if (!fs.existsSync(file)) {
      return svc.kind === "interactive"
        ? "the panel owns its output (rundev does not capture it)"
        : `no log yet (${path.relative(loaded.root, file)})`
    }
    const lines = fs.readFileSync(file, "utf8").split("\n")
    const out = lines.slice(-tail).join("\n").trimEnd()
    return out || "(the log is still empty)"
  }
  if (svc.kind === "compose") {
    const r = await run("docker", composeArgs(svc, ["logs", "--tail", String(tail), svc.service ?? name]), {
      cwd: serviceCwd(loaded, svc),
      timeoutMs: 20_000,
    })
    return (r.out + r.err).trim() || "(no output)"
  }
  return "this service has no logs"
}

function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).find(Boolean) ?? ""
}
