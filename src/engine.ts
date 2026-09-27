/**
 * engine.ts — the mechanics. Runtime-agnostic: runs inside the OpenCode server
 * (agent tools) and inside the TUI process (the /rundev command), and can be
 * smoke-tested with plain `deno run`.
 *
 * Ownership rule: rundev only stops what rundev started. Anything else is
 * reported, never touched.
 */

import { execFile, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { composeFiles, serviceCwd, type Loaded, type Service, type Target } from "./manifest.ts"

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

export function ensureStateDir(root: string): string {
  const dir = stateDir(root)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function eventsFile(root: string): string {
  return path.join(stateDir(root), "events.jsonl")
}

export interface RundevEvent {
  /** `event` → toast; `report` → dialog with the full text. */
  type: "event" | "report"
  level?: "info" | "ok" | "warn" | "error"
  service?: string
  message?: string
  title?: string
  text?: string
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
  if (!st) return { ok: true, detail: "no lo levantó rundev (nada que bajar)" }
  if (!alive(st.pid)) return { ok: true, detail: `ya estaba muerto (pid ${st.pid})` }

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
    if (!alive(st.pid)) return { ok: true, detail: `detenido (pid ${st.pid})` }
    await sleep(150)
  }
  signal("SIGKILL")
  await sleep(300)
  return alive(st.pid)
    ? { ok: false, detail: `no murió (pid ${st.pid}) — revisalo a mano` }
    : { ok: true, detail: `detenido a la fuerza (pid ${st.pid})` }
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
    return { state: "error", detail: firstLine(r.err) || "docker compose ps falló" }
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
  if (!row) return { state: "stopped", detail: "contenedor inexistente" }
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
  if (r.code !== 0) return { ok: false, detail: firstLine(r.err) || "docker compose up falló" }
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const st = await composeState(loaded, name, svc)
    if (st.state === "running") return { ok: true, detail: st.detail }
    await sleep(700)
  }
  return { ok: true, detail: "arrancando (sin confirmar todavía)" }
}

export async function composeStop(loaded: Loaded, name: string, svc: Service) {
  const target = svc.service ?? name
  const r = await run("docker", composeArgs(svc, ["stop", target]), {
    cwd: serviceCwd(loaded, svc),
    timeoutMs: 60_000,
  })
  return r.code === 0
    ? { ok: true, detail: "detenido (contenedor conservado)" }
    : { ok: false, detail: firstLine(r.err) || "docker compose stop falló" }
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
  fs.mkdirSync(profile, { recursive: true })
  const url = svc.url ?? `http://localhost:${svc.port}`
  const r = await run(
    "/usr/bin/open",
    ["-na", "Google Chrome", "--args", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", url],
    { timeoutMs: 20_000 },
  )
  return r.code === 0
    ? { ok: true, detail: `abierto ${url} (perfil ${path.relative(loaded.root, profile)})` }
    : { ok: false, detail: firstLine(r.err) || "no se pudo abrir Chrome" }
}

export async function browserDown(loaded: Loaded, name: string, svc: Service) {
  const pids = await browserPids(loaded, svc)
  if (pids.length === 0) return { ok: true, detail: "ya estaba cerrado" }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      /* ignore */
    }
  }
  return { ok: true, detail: `cerrado (${pids.length} proceso(s))` }
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
  if (!info) return { ok: false, detail: "no hay .env en este repo" }
  if (!info.sections.includes(section)) {
    return { ok: false, detail: `sección "${section}" no existe (hay: ${info.sections.join(", ") || "ninguna"})` }
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
  return { ok: true, detail: `sección ${section} activada en .env` }
}

// ──────────────────────────────────────────────────────────────────── status

export type State = "running" | "stopped" | "starting" | "external" | "unknown" | "error"

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
  if (!svc) return { name, kind: "process", state: "error", detail: "no está en el manifiesto" }

  const base: ServiceStatus = { name, kind: svc.kind, state: "unknown", detail: "", port: svc.port }

  if (svc.kind === "compose") {
    const st = await composeState(loaded, name, svc)
    return { ...base, state: st.state, detail: st.detail }
  }

  if (svc.kind === "browser") {
    const pids = await browserPids(loaded, svc)
    return pids.length
      ? { ...base, state: "running", detail: `Chrome con perfil del proyecto (${pids.length} proc)`, pid: pids[0] }
      : { ...base, state: "stopped", detail: "cerrado" }
  }

  if (svc.kind === "process") {
    const st = readProc(loaded.root, name)
    if (st && alive(st.pid)) {
      const ready = await checkCommand(loaded, svc)
      return {
        ...base,
        state: "running",
        detail: ready === false ? "proceso vivo, pero el check falla" : `pid ${st.pid}`,
        pid: st.pid,
      }
    }
    const holders = svc.port ? await portPids(svc.port) : []
    if (holders.length) {
      return {
        ...base,
        state: "external",
        detail: `puerto ${svc.port} ocupado por un proceso que no levantó rundev`,
        holders,
      }
    }
    return { ...base, state: "stopped", detail: st ? `estado viejo (pid ${st.pid} muerto)` : "no lo levantó rundev" }
  }

  // interactive
  const st = readProc(loaded.root, name)
  return st
    ? { ...base, state: "running", detail: `lanzado (${new Date(st.startedAt).toLocaleTimeString()})`, pid: st.pid }
    : { ...base, state: "unknown", detail: "no puedo verificar un panel abierto (no hay IPC del terminal)" }
}

export async function statusAll(loaded: Loaded): Promise<ServiceStatus[]> {
  return Promise.all(Object.keys(loaded.manifest.services).map((n) => statusOf(loaded, n)))
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
    return { error: `target "${targetName}" no existe (hay: ${Object.keys(svc.targets).join(", ")})` }
  }
  const command = resolved?.target.launch ?? svc.up
  if (!command) return { error: `${name}: no hay comando de lanzamiento` }

  let envWarning: string | undefined
  const section = resolved?.target.envSection
  if (section) {
    const info = envSections(cwd)
    if (info && info.sections.length > 0 && info.active !== section) {
      envWarning =
        `el .env tiene activa la sección ${info.active ?? "(ninguna)"} y este target pide ${section} — ` +
        `cambiala antes de lanzar (o pedime que lo haga: /rundev env ${section})`
    }
  }
  const label = `${path.basename(cwd)}${resolved ? ` · ${resolved.name}` : ""}`
  return { name, label, command, cwd, target: resolved?.name, envWarning }
}

export async function up(loaded: Loaded, names: string[], opts: UpOptions = {}): Promise<UpResult[]> {
  const results: UpResult[] = []
  const emitEv = (ev: RundevEvent) => {
    emit(loaded.root, ev)
    opts.onEvent?.(ev)
  }

  for (const name of names) {
    const svc = loaded.manifest.services[name]
    if (!svc) {
      results.push({ name, action: "failed", detail: "no está en el manifiesto" })
      continue
    }
    const st = await statusOf(loaded, name)
    if (st.state === "running") {
      emitEv({ type: "event", level: "ok", service: name, message: `ya estaba arriba · ${st.detail}` })
      results.push({ name, action: "already", detail: st.detail })
      continue
    }

    if (svc.kind === "compose") {
      emitEv({ type: "event", level: "info", service: name, message: "arrancando contenedor…" })
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
      emitEv({ type: "event", level: "info", service: name, message: `arrancando · pid ${st2.pid}` })
      let detail = `pid ${st2.pid}`
      const waitMs = opts.waitMs ?? 10_000
      if (waitMs > 0) {
        const deadline = Date.now() + waitMs
        while (Date.now() < deadline) {
          const ready = await checkCommand(loaded, svc)
          if (ready === true) {
            detail = `pid ${st2.pid} · listo`
            break
          }
          if (ready === null) break
          await sleep(500)
        }
      }
      emitEv({ type: "event", level: "ok", service: name, message: detail })
      results.push({ name, action: "started", detail, pid: st2.pid })
      continue
    }

    if (svc.kind === "browser") {
      const r = await browserUp(loaded, name, svc)
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

  return results
}

export async function down(loaded: Loaded, names: string[]): Promise<UpResult[]> {
  const results: UpResult[] = []
  const emitEv = (ev: RundevEvent) => emit(loaded.root, ev)

  for (const name of names) {
    const svc = loaded.manifest.services[name]
    if (!svc) {
      results.push({ name, action: "failed", detail: "no está en el manifiesto" })
      continue
    }
    let r: { ok: boolean; detail: string }
    if (svc.kind === "compose") r = await composeStop(loaded, name, svc)
    else if (svc.kind === "process") r = await stopProcess(loaded.root, name)
    else if (svc.kind === "browser") r = await browserDown(loaded, name, svc)
    else r = { ok: true, detail: "el panel es tuyo: cerralo con ctrl+C" }

    emitEv({ type: "event", level: r.ok ? "ok" : "warn", service: name, message: r.detail })
    results.push({ name, action: r.ok ? "stopped" : "failed", detail: r.detail })
  }
  return results
}

// ───────────────────────────────────────────────────────────────────── logs

export async function logs(loaded: Loaded, name: string, tail = 40): Promise<string> {
  const svc = loaded.manifest.services[name]
  if (!svc) return `no está en el manifiesto`
  if (svc.kind === "process" || svc.kind === "interactive") {
    const st = readProc(loaded.root, name)
    const file = st?.log ?? path.join(stateDir(loaded.root), `${name}.log`)
    if (!fs.existsSync(file)) return `sin log todavía (${path.relative(loaded.root, file)})`
    const lines = fs.readFileSync(file, "utf8").split("\n")
    const out = lines.slice(-tail).join("\n").trimEnd()
    return out || "(el log todavía está vacío)"
  }
  if (svc.kind === "compose") {
    const r = await run("docker", composeArgs(svc, ["logs", "--tail", String(tail), svc.service ?? name]), {
      cwd: serviceCwd(loaded, svc),
      timeoutMs: 20_000,
    })
    return (r.out + r.err).trim() || "(sin salida)"
  }
  return "este servicio no tiene logs"
}

function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).find(Boolean) ?? ""
}
