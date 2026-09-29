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
import { composeFiles, quoteForTyping, serviceCwd, type Loaded, type Service, type Target } from "./manifest.ts"

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
  opts: { cwd?: string; timeoutMs?: number } = {},
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
  const r = await run("flutter", ["emulators"], { timeoutMs: 60_000 })
  const ids = r.out
    .split("\n")
    .filter((l) => l.includes("•"))
    .map((l) => l.split("•")[0]?.trim() ?? "")
    .filter((id) => id && !/^id$/i.test(id))
  return [...new Set(ids)]
}

/** Available iOS simulators (`xcrun simctl list devices available`), best effort. */
export async function detectSimulators(): Promise<string[]> {
  const r = await run("/usr/bin/xcrun", ["simctl", "list", "devices", "available"], { timeoutMs: 60_000 })
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
  let current: any = {}
  try {
    current = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    current = {}
  }
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

export function startProcess(root: string, name: string, command: string, cwd: string): ProcState {
  const dir = ensureStateDir(root)
  const log = path.join(dir, `${name}.log`)
  const fd = fs.openSync(log, "a")
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
  opts: { killAfterMs?: number } = {},
): Promise<{ ok: boolean; detail: string }> {
  const st = readProc(root, name)
  if (!st) return { ok: true, detail: "not started by rundev (nothing to stop)" }
  if (!alive(st.pid)) return { ok: true, detail: `already dead (pid ${st.pid})` }

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
  const deadline = Date.now() + (opts.killAfterMs ?? 4_000)
  while (Date.now() < deadline) {
    if (!alive(st.pid)) return { ok: true, detail: `stopped (pid ${st.pid})` }
    await sleep(150)
  }
  signal("SIGKILL")
  await sleep(300)
  return alive(st.pid)
    ? { ok: false, detail: `did not exit (pid ${st.pid}) — check it manually` }
    : { ok: true, detail: `force-stopped (pid ${st.pid})` }
}

// ──────────────────────────────────────────────────────────────────── ports

export async function portPids(port: number): Promise<number[]> {
  const r = await run("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeoutMs: 5_000 })
  return r.out
    .split("\n")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
}

// ──────────────────────────────────────────────────────────────────── compose

function composeArgs(svc: Service, cmd: string[]): string[] {
  const files = Array.isArray(svc.file) ? svc.file : svc.file ? [svc.file] : []
  return ["compose", ...files.flatMap((f) => ["-f", f]), ...cmd]
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
  const row = rows.find(
    (c) => c.Service === target || c.service === target || String(c.Name ?? c.name ?? "").includes(target),
  )
  if (!row) return { state: "stopped", detail: "container does not exist" }
  const state = String(row.State ?? row.state ?? "")
  const status = String(row.Status ?? row.status ?? state)
  return state.startsWith("running") ? { state: "running", detail: status } : { state: "stopped", detail: status }
}

export async function composeUp(loaded: Loaded, name: string, svc: Service, waitMs: number) {
  const target = svc.service ?? name
  const r = await run("docker", composeArgs(svc, ["up", "-d", target]), {
    cwd: serviceCwd(loaded, svc),
    timeoutMs: waitMs,
  })
  if (r.code !== 0) return { ok: false, detail: firstLine(r.err) || "docker compose up failed" }
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
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

async function adbDevices(): Promise<string[]> {
  const r = await run("adb", ["devices"], { timeoutMs: 15_000 })
  return r.out
    .split("\n")
    .slice(1)
    .map((l) => l.split("\t")[0]?.trim() ?? "")
    .filter((s) => s.startsWith("emulator-"))
}

export async function emulatorState(svc: Service): Promise<{ state: State; detail: string }> {
  const devices = await adbDevices()
  return devices.length
    ? { state: "running", detail: devices.join(", ") }
    : { state: "stopped", detail: "no emulator connected" }
}

/** Launches the AVD and waits (bounded) until Android reports boot completed. */
export async function emulatorUp(
  loaded: Loaded,
  name: string,
  svc: Service,
  emitEv: (ev: RundevEvent) => void,
): Promise<{ ok: boolean; detail: string }> {
  const avd = svc.avd
  if (!avd) return { ok: false, detail: "emulator service without `avd`" }
  const already = await adbDevices()
  if (already.length) return { ok: true, detail: `already connected (${already.join(", ")})` }

  const log = path.join(ensureStateDir(loaded.root), `${name}.log`)
  const fd = fs.openSync(log, "a")
  const child = spawn("/bin/sh", ["-lc", `flutter emulators --launch ${avd}`], {
    detached: true,
    stdio: ["ignore", fd, fd],
  })
  child.unref()
  fs.closeSync(fd)
  emitEv({ type: "event", level: "info", service: name, message: `launching AVD ${avd}…` })

  const waitMs = svc.waitMs ?? 180_000
  const deadline = Date.now() + waitMs
  let serial: string | null = null
  while (Date.now() < deadline && !serial) {
    serial = (await adbDevices())[0] ?? null
    if (!serial) await sleep(1_000)
  }
  if (!serial) {
    return { ok: false, detail: `AVD ${avd} did not appear in \`adb devices\` within ${waitMs / 1000}s — check the emulator window` }
  }
  emitEv({ type: "event", level: "info", service: name, message: `${serial} connected · waiting for boot…` })

  let ticks = 0
  while (Date.now() < deadline) {
    const r = await run("adb", ["-s", serial, "shell", "getprop", "sys.boot_completed"], { timeoutMs: 10_000 })
    if (r.out.trim() === "1") return { ok: true, detail: `${serial} booted (${avd})` }
    if (++ticks % 5 === 0) {
      emitEv({ type: "event", level: "info", service: name, message: `still booting ${serial}…` })
    }
    await sleep(2_000)
  }
  return { ok: false, detail: `${serial} did not finish booting within the wait — it usually finishes on its own` }
}

/** Fire-and-forget by design: the emulator may save a quick-boot snapshot while closing. */
export async function emulatorDown(name: string): Promise<{ ok: boolean; detail: string }> {
  const devices = await adbDevices()
  if (devices.length === 0) return { ok: true, detail: "already off" }
  for (const serial of devices) {
    const child = spawn("/usr/bin/env", ["adb", "-s", serial, "emu", "kill"], { detached: true, stdio: "ignore" })
    child.unref()
  }
  return { ok: true, detail: `kill order sent to ${devices.join(", ")} (it may take a few seconds to close)` }
}

async function bootedSimulators(): Promise<string[]> {
  const r = await run("/usr/bin/xcrun", ["simctl", "list", "devices", "booted"], { timeoutMs: 30_000 })
  return r.out
    .split("\n")
    .filter((l) => l.includes("(Booted)"))
    .map((l) => l.split("(")[0]?.trim() ?? "")
    .filter(Boolean)
}

export async function simulatorState(svc: Service): Promise<{ state: State; detail: string }> {
  const booted = await bootedSimulators()
  return booted.length
    ? { state: "running", detail: booted.join(", ") }
    : { state: "stopped", detail: "no simulator booted" }
}

export async function simulatorUp(
  name: string,
  svc: Service,
  emitEv: (ev: RundevEvent) => void,
): Promise<{ ok: boolean; detail: string }> {
  const device = svc.device
  if (!device) return { ok: false, detail: "simulator service without `device`" }
  const booted = await bootedSimulators()
  if (booted.length) return { ok: true, detail: `already booted (${booted.join(", ")})` }

  emitEv({ type: "event", level: "info", service: name, message: `booting ${device}…` })
  await run("/usr/bin/xcrun", ["simctl", "boot", device], { timeoutMs: 90_000 })
  const open = spawn("/usr/bin/open", ["-a", "Simulator"], { detached: true, stdio: "ignore" })
  open.unref()

  const waitMs = svc.waitMs ?? 90_000
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const now = await bootedSimulators()
    if (now.length) return { ok: true, detail: `${now[0]} booted` }
    await sleep(1_500)
  }
  return { ok: false, detail: `${device} did not boot within ${waitMs / 1000}s` }
}

export async function simulatorDown(): Promise<{ ok: boolean; detail: string }> {
  const booted = await bootedSimulators()
  if (booted.length === 0) return { ok: true, detail: "already shut down" }
  for (const device of booted) {
    const child = spawn("/usr/bin/xcrun", ["simctl", "shutdown", device], { detached: true, stdio: "ignore" })
    child.unref()
  }
  return { ok: true, detail: `shutdown order sent to ${booted.join(", ")}` }
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
  if (!sessionID) return
  const file = writeReport(root, text)
  const quoted = quoteForTyping(file) ?? file
  const body = JSON.stringify({ command: `cat ${quoted}` })
  try {
    const child = spawn("opencode", ["api", "post", `/api/session/${sessionID}/shell`, "--data", body], {
      detached: true,
      stdio: "ignore",
    })
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

async function checkCommand(loaded: Loaded, svc: Service): Promise<boolean | null> {
  if (svc.check) {
    const r = await run("/bin/sh", ["-lc", svc.check], { cwd: serviceCwd(loaded, svc), timeoutMs: 10_000 })
    return r.code === 0
  }
  if (svc.health) {
    const r = await run("/usr/bin/curl", ["-sf", "-o", "/dev/null", "--max-time", "4", svc.health], { timeoutMs: 8_000 })
    return r.code === 0
  }
  return null
}

export async function statusOf(loaded: Loaded, name: string): Promise<ServiceStatus> {
  const svc = loaded.manifest.services[name]
  if (!svc) return { name, kind: "process", state: "error", detail: "not in the manifest" }

  const base: ServiceStatus = { name, kind: svc.kind, state: "unknown", detail: "", port: svc.port }

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
    if (st && alive(st.pid)) {
      const ready = await checkCommand(loaded, svc)
      if (ready === false) {
        return { ...base, state: "unhealthy", detail: `alive but the check fails (pid ${st.pid})`, pid: st.pid }
      }
      return { ...base, state: "running", detail: `pid ${st.pid}`, pid: st.pid }
    }
    const holders = svc.port ? await portPids(svc.port) : []
    if (holders.length) {
      return {
        ...base,
        state: "external",
        detail: `port ${svc.port} held by a process rundev did not start`,
        holders,
      }
    }
    return { ...base, state: "stopped", detail: st ? `pid ${st.pid} exited` : "not started by rundev" }
  }

  // interactive
  const st = readProc(loaded.root, name)
  return st
    ? { ...base, state: "running", detail: `lanzado (${new Date(st.startedAt).toLocaleTimeString()})`, pid: st.pid }
    : { ...base, state: "unknown", detail: "cannot verify an open panel (no terminal IPC)" }
}

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
  envWarning?: string
}

export interface UpResult {
  name: string
  action: "started" | "already" | "blocked" | "manual" | "failed" | "stopped"
  detail: string
  pid?: number
}

export interface UpOptions {
  /** Bounded wait for readiness (ms). 0 = fire and report. */
  waitMs?: number
  /** Launcher for interactive services (the plugin wires the terminal here). */
  launch?: (plan: LaunchPlan) => Promise<{ ok: boolean; detail: string }>
  /** `app` → `ios`: which target to launch per interactive service. */
  targets?: Record<string, string>
  onEvent?: (ev: RundevEvent) => void
}

/** Resolves a target for an interactive service: `app@ios`, `app`, → Target. */
export function resolveTarget(svc: Service, target?: string): { name: string; target: Target } | null {
  if (!svc.targets) return null
  const name = target ?? svc.defaultTarget ?? Object.keys(svc.targets)[0]
  const t = svc.targets[name]
  return t ? { name, target: t } : null
}

export function launchPlan(loaded: Loaded, name: string, svc: Service, targetName?: string): LaunchPlan | { error: string } {
  const cwd = serviceCwd(loaded, svc)
  const resolved = svc.targets ? resolveTarget(svc, targetName) : null
  if (svc.targets && !resolved) {
    return { error: `target "${targetName}" does not exist (found: ${Object.keys(svc.targets).join(", ")})` }
  }
  const command = resolved?.target.launch ?? svc.up
  if (!command) return { error: `${name}: no launch command` }

  let envWarning: string | undefined
  const section = resolved?.target.envSection
  if (section) {
    const info = envSections(cwd)
    if (info && info.sections.length > 0 && info.active !== section) {
      envWarning =
        `the .env has section ${info.active ?? "(none)"} active and this target needs ${section} — ` +
        `switch it before launching (or ask me: /rundev env ${section})`
    }
  }
  const label = `${path.basename(cwd)}${resolved ? ` · ${resolved.name}` : ""}`
  return { name, label, command, cwd, target: resolved?.name, envWarning }
}

/** Puts each service's target requirements before it (emulator → app). */
export function expandRequires(loaded: Loaded, names: string[], targets: Record<string, string> = {}): string[] {
  const out: string[] = []
  const visit = (name: string, depth = 0) => {
    if (depth > 4 || out.includes(name)) return
    const svc = loaded.manifest.services[name]
    if (!svc) {
      out.push(name)
      return
    }
    const resolved = svc.targets ? resolveTarget(svc, targets[name]) : null
    for (const dep of resolved?.target.requires ?? []) visit(dep, depth + 1)
    if (!out.includes(name)) out.push(name)
  }
  for (const name of names) visit(name)
  return out
}

export async function up(loaded: Loaded, names: string[], opts: UpOptions = {}): Promise<UpResult[]> {
  const results: UpResult[] = []
  const emitEv = (ev: RundevEvent) => {
    emit(loaded.root, ev)
    opts.onEvent?.(ev)
  }
  emitEv({ type: "event", level: "info", message: `up: ${names.join(", ")}` })

  for (const name of expandRequires(loaded, names, opts.targets)) {
    const svc = loaded.manifest.services[name]
    if (!svc) {
      results.push({ name, action: "failed", detail: "not in the manifest" })
      continue
    }
    const st = await statusOf(loaded, name)
    if (st.state === "unhealthy") {
      // alive but not serving: recover it (we own the pidfile, so a restart is safe)
      emitEv({ type: "event", level: "warn", service: name, message: "alive but unhealthy → restarting" })
      await stopProcess(loaded.root, name)
    } else if (st.state === "running") {
      emitEv({ type: "event", level: "ok", service: name, message: `already up · ${st.detail}` })
      results.push({ name, action: "already", detail: st.detail })
      continue
    }

    if (svc.kind === "compose") {
      emitEv({ type: "event", level: "info", service: name, message: "starting container…" })
      const r = await composeUp(loaded, name, svc, opts.waitMs ?? 60_000)
      emitEv({
        type: "event",
        level: r.ok ? "ok" : "error",
        service: name,
        message: r.detail,
      })
      results.push({ name, action: r.ok ? "started" : "failed", detail: r.detail })
      continue
    }

    if (svc.kind === "process") {
      const st2 = startProcess(loaded.root, name, svc.up as string, serviceCwd(loaded, svc))
      emitEv({ type: "event", level: "info", service: name, message: `starting · pid ${st2.pid}` })
      let detail = `pid ${st2.pid}`
      const wantsCheck = Boolean(svc.check || svc.health)
      let ready = false
      const waitMs = opts.waitMs ?? 10_000
      if (waitMs > 0) {
        const deadline = Date.now() + waitMs
        while (Date.now() < deadline) {
          const ok = await checkCommand(loaded, svc)
          if (ok === true) {
            ready = true
            detail = `pid ${st2.pid} · ready`
            break
          }
          if (ok === null) {
            ready = true // nothing to verify against
            break
          }
          await sleep(500)
        }
      } else {
        ready = true
      }
      if (wantsCheck && !ready) {
        const tail = (await logs(loaded, name, 6)).trim()
        detail = `pid ${st2.pid} · started but not ready — last log lines:\n${tail || "(no output yet)"}`
      }
      emitEv({
        type: "event",
        level: wantsCheck && !ready ? "error" : "ok",
        service: name,
        message: detail.split("\n")[0],
      })
      results.push({ name, action: wantsCheck && !ready ? "failed" : "started", detail, pid: st2.pid })
      continue
    }

    if (svc.kind === "browser") {
      const r = await browserUp(loaded, name, svc)
      emitEv({ type: "event", level: r.ok ? "ok" : "error", service: name, message: r.detail })
      results.push({ name, action: r.ok ? "started" : "failed", detail: r.detail })
      continue
    }

    if (svc.kind === "emulator") {
      const r = await emulatorUp(loaded, name, svc, emitEv)
      emitEv({ type: "event", level: r.ok ? "ok" : "error", service: name, message: r.detail })
      results.push({ name, action: r.ok ? "started" : "failed", detail: r.detail })
      continue
    }

    if (svc.kind === "simulator") {
      const r = await simulatorUp(name, svc, emitEv)
      emitEv({ type: "event", level: r.ok ? "ok" : "error", service: name, message: r.detail })
      results.push({ name, action: r.ok ? "started" : "failed", detail: r.detail })
      continue
    }

    // interactive → the launcher decides (terminal panel or manual command)
    const plan = launchPlan(loaded, name, svc, opts.targets?.[name])
    if ("error" in plan) {
      results.push({ name, action: "failed", detail: plan.error })
      continue
    }
    if (plan.envWarning) {
      emitEv({ type: "event", level: "warn", service: name, message: plan.envWarning })
      results.push({ name, action: "blocked", detail: plan.envWarning })
      continue
    }
    if (!opts.launch) {
      results.push({ name, action: "manual", detail: plan.command })
      continue
    }
    const r = await opts.launch(plan)
    emitEv({ type: "event", level: r.ok ? "ok" : "warn", service: name, message: r.detail })
    results.push({ name, action: r.ok ? "started" : "failed", detail: r.detail })
  }

  await statusAll(loaded) // refresh the snapshot: the sidebar must not go stale
  return results
}

export async function down(loaded: Loaded, names: string[]): Promise<UpResult[]> {
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
    else if (svc.kind === "process") r = await stopProcess(loaded.root, name)
    else if (svc.kind === "browser") r = await browserDown(loaded, name, svc)
    else if (svc.kind === "emulator") r = await emulatorDown(name)
    else if (svc.kind === "simulator") r = await simulatorDown()
    else r = { ok: true, detail: "the panel is yours: close it with ctrl+C" }

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
    if (!fs.existsSync(file)) return `no log yet (${path.relative(loaded.root, file)})`
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
