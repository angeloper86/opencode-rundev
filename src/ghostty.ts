/**
 * ghostty.ts — open a panel through Ghostty's own scripting API (1.3+).
 *
 * The old launcher activated Ghostty and then *typed* into "the frontmost app"
 * through System Events. If the focus moved in the meantime — or macOS refused
 * the activation, which it does for background processes — the keystrokes (and
 * the Enter) landed in whatever window was in front: a form, a document, a chat.
 *
 * Here nothing depends on the focus. The terminal to split is identified by its
 * tty (the TUI registers it, see clients.ts) and the split, the text and the
 * Enter are addressed to that terminal's id. If the terminal cannot be
 * identified for sure, nothing is typed anywhere: the caller falls back to the
 * clipboard.
 */

import { execFile } from "node:child_process"
import path from "node:path"
import { listClients } from "./clients.ts"

export interface GhosttyTerminal {
  id: string
  tty: string
  /** Foreground process of the terminal. */
  pid: number
  cwd: string
}

export interface GhosttyStatus {
  ok: boolean
  version?: string
  reason?: string
}

interface Osa {
  code: number
  out: string
  err: string
}

/** Runs AppleScript (one `-e` per line). Never throws. */
export function osa(lines: string[], timeoutMs = 20_000): Promise<Osa> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      lines.flatMap((line) => ["-e", line]),
      { timeout: timeoutMs },
      (err: any, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          out: String(stdout ?? "").trim(),
          err: String(stderr ?? "").trim(),
        })
      },
    )
  })
}

const q = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`

/** Is Ghostty running, and does it answer its scripting API (1.3+)? Never launches it. */
export async function ghosttyStatus(): Promise<GhosttyStatus> {
  if (process.platform !== "darwin") return { ok: false, reason: "Ghostty scripting is macOS only" }
  const running = await osa(['application "Ghostty" is running'], 8_000)
  if (running.out !== "true") return { ok: false, reason: "Ghostty is not running" }
  const v = await osa(['tell application "Ghostty" to return (version as text) & " " & (count of terminals)'], 10_000)
  if (v.code !== 0) {
    return {
      ok: false,
      reason: /-1743|not allowed|not authorized/i.test(v.err)
        ? "no Automation permission for Ghostty (System Settings → Privacy & Security → Automation)"
        : `Ghostty has no scripting API (needs 1.3+): ${v.err.split("\n")[0]}`,
    }
  }
  return { ok: true, version: v.out.split(" ")[0] }
}

/** Every terminal Ghostty has open, with the tty and the foreground process of each. */
export async function listTerminals(): Promise<GhosttyTerminal[] | null> {
  const r = await osa(
    [
      'tell application "Ghostty"',
      'set out to ""',
      // `tab` would be Ghostty's own `tab` CLASS inside this tell block, not a tabulator
      "set sep to (ASCII character 9)",
      "repeat with t in terminals",
      'set out to out & (id of t) & sep & (tty of t) & sep & (pid of t) & sep & (working directory of t) & linefeed',
      "end repeat",
      "return out",
      "end tell",
    ],
    15_000,
  )
  if (r.code !== 0) return null
  return r.out
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((p) => p.length >= 4 && p[0])
    .map((p) => ({ id: p[0], tty: p[1], pid: Number(p[2]), cwd: p.slice(3).join("\t") }))
}

/** Command name of a pid (`opencode`, `zsh`, `dartvm`…), without path or the login dash. */
export function commandOf(pid: number): Promise<string> {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-o", "comm=", "-p", String(pid)], { timeout: 3_000 }, (_err, stdout) => {
      resolve(path.basename(String(stdout ?? "").trim()).replace(/^-/, ""))
    })
  })
}

const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "login", "tmux", "ksh", "nu"])
export const isShell = (command: string) => SHELLS.has(command)

const related = (a: string, b: string) => {
  const x = path.resolve(a)
  const y = path.resolve(b)
  return x === y || x.startsWith(`${y}${path.sep}`) || y.startsWith(`${x}${path.sep}`)
}

export interface HostPick {
  terminal?: GhosttyTerminal
  /** How it was found, or why it was not. */
  reason: string
}

/**
 * The terminal that hosts this session's OpenCode — never "whichever has the focus".
 *  1. the TUI registered its tty for this session → exact;
 *  2. otherwise the only terminal running `opencode` in this directory;
 *  3. otherwise nothing: ambiguity is reported, not guessed.
 */
export async function pickHostTerminal(opts: {
  sessionID?: string
  dir: string
  terminals: GhosttyTerminal[]
}): Promise<HostPick> {
  const { terminals } = opts
  if (opts.sessionID) {
    const client = listClients().find((c) => c.sessionID === opts.sessionID && c.tty)
    const hit = client ? terminals.find((t) => t.tty === client.tty) : undefined
    if (hit) return { terminal: hit, reason: `the TUI of this session lives in ${hit.tty}` }
  }
  const commands = await Promise.all(terminals.map((t) => commandOf(t.pid)))
  const candidates = terminals.filter((t, i) => commands[i].startsWith("opencode") && related(t.cwd, opts.dir))
  if (candidates.length === 1) return { terminal: candidates[0], reason: `the only OpenCode terminal in ${path.basename(opts.dir)}` }
  const exact = candidates.filter((t) => path.resolve(t.cwd) === path.resolve(opts.dir))
  if (exact.length === 1) return { terminal: exact[0], reason: `the only OpenCode terminal at ${path.basename(opts.dir)}` }
  if (candidates.length === 0) return { reason: "no Ghostty terminal is running OpenCode for this directory" }
  return {
    reason: `${candidates.length} Ghostty terminals run OpenCode here and the TUI did not say which is this session's — open the panel by hand`,
  }
}

export interface SplitResult {
  ok: boolean
  terminalId?: string
  detail: string
}

/**
 * Splits `hostId`, runs `line` in the NEW terminal and gives the keyboard back
 * to the host: Ghostty focuses a new split, and whatever the person is typing
 * into OpenCode at that moment must not end up in the new shell.
 */
export async function splitTerminal(opts: {
  hostId: string
  cwd: string
  line: string
  direction?: "down" | "right"
  /** Leave the keyboard in the new panel instead of the host. */
  focus?: boolean
}): Promise<SplitResult> {
  const direction = opts.direction ?? "down"
  const back = direction === "down" ? "up" : "left"
  const r = await osa(
    [
      'tell application "Ghostty"',
      `set hostTerm to first terminal whose id is ${q(opts.hostId)}`,
      "set cfg to new surface configuration",
      `set initial working directory of cfg to ${q(opts.cwd)}`,
      `set newTerm to split hostTerm direction ${direction} with configuration cfg`,
      `input text ${q(opts.line)} to newTerm`,
      'send key "enter" to newTerm',
      ...(opts.focus ? [] : [`perform action "goto_split:${back}" on newTerm`]),
      "return id of newTerm",
      "end tell",
    ],
    20_000,
  )
  if (r.code !== 0) {
    return { ok: false, detail: /-1743|not allowed|not authorized/i.test(r.err) ? "no Automation permission for Ghostty" : r.err.split("\n")[0] || "osascript failed" }
  }
  return { ok: true, terminalId: r.out, detail: `split ${direction} of the OpenCode terminal` }
}

export interface PanelProbe {
  exists: boolean
  /** Foreground command of the panel (`dartvm`, `zsh`…). */
  command?: string
  /** The panel is back at a shell prompt: what it ran has ended. */
  idle?: boolean
}

const byId = (id: string) => `first terminal whose id is ${q(id)}`

export interface InterruptResult {
  /**
   * gone: the panel was closed already · idle: nothing runs in it (a shell prompt) ·
   * stopped: it was running and ended after Ctrl+C · still-running: Ctrl+C did not end it ·
   * unknown: Ghostty could not be asked.
   */
  state: "gone" | "idle" | "stopped" | "still-running" | "unknown"
  /** What ran (or still runs) in the panel. */
  command?: string
  closed?: boolean
}

/**
 * Stops what rundev launched in its panel: Ctrl+C sent to THAT terminal (by id, so
 * it does not depend on the focus), and only when something other than a shell is
 * running in it — a pane that went back to its prompt is never interrupted.
 * `close` also closes the pane once it is idle; it is never closed while something runs.
 */
export async function interruptPanel(
  terminalId: string,
  opts: { close?: boolean; waitMs?: number } = {},
): Promise<InterruptResult> {
  const probe = await probePanel(terminalId)
  if (!probe) return { state: "unknown" }
  if (!probe.exists) return { state: "gone" }
  const close = async (): Promise<boolean> =>
    opts.close ? (await osa(['tell application "Ghostty"', `close (${byId(terminalId)})`, "end tell"], 10_000)).code === 0 : false

  if (probe.idle) return { state: "idle", command: probe.command, closed: await close() }

  await osa(['tell application "Ghostty"', `send key "c" modifiers "control" to (${byId(terminalId)})`, "end tell"], 10_000)
  const deadline = Date.now() + (opts.waitMs ?? 8_000)
  let last: PanelProbe | null = probe
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    last = await probePanel(terminalId)
    if (!last || !last.exists) return { state: "stopped", command: probe.command }
    if (last.idle) return { state: "stopped", command: probe.command, closed: await close() }
  }
  return { state: "still-running", command: last?.command ?? probe.command }
}

/** Is a panel rundev opened still there, and is it still running something? `null` = cannot tell. */
export async function probePanel(terminalId: string): Promise<PanelProbe | null> {
  const terminals = await listTerminals()
  if (!terminals) return null
  const t = terminals.find((x) => x.id === terminalId)
  if (!t) return { exists: false }
  const command = await commandOf(t.pid)
  return { exists: true, command, idle: isShell(command) }
}
