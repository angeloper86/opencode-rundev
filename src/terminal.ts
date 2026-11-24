/**
 * terminal.ts — opens a panel running a command.
 *
 * Golden rule: never type into "whatever has the focus". On Ghostty the panel is
 * opened through its scripting API, addressed to the terminal that hosts this
 * OpenCode session (see ghostty.ts). If that terminal cannot be identified, or
 * there is no Ghostty, the command goes to the clipboard and the report says so:
 * the person pastes it where they want. A wrong window is never a possible outcome.
 */

import { run } from "./engine.ts"
import { ghosttyStatus, listTerminals, pickHostTerminal, splitTerminal } from "./ghostty.ts"
import { quoteForTyping } from "./manifest.ts"

/**
 * ghostty-api: split the terminal that hosts this session · clipboard: copy the command ·
 * open: a new Ghostty window · print: touch nothing, just report the command to run.
 */
export type TerminalStrategy = "ghostty-api" | "clipboard" | "open" | "print"

/** Accepts the old name (`ghostty-split`) so existing flags keep working. */
export function parseStrategy(value?: string): TerminalStrategy | undefined {
  if (!value) return undefined
  if (value === "ghostty-api" || value === "ghostty-split" || value === "ghostty") return "ghostty-api"
  if (value === "clipboard" || value === "open" || value === "print") return value
  return undefined
}

export interface PanelRequest {
  /** Absolute directory the command runs in. */
  cwd: string
  /** Command to run inside the panel. */
  command: string
  /** Human label echoed in the panel header. */
  label: string
  strategy?: TerminalStrategy
  /** Session that asked: identifies its OpenCode terminal exactly. */
  sessionID?: string
  /** Directory of the session (to find its terminal when the TUI did not register). */
  dir?: string
  direction?: "down" | "right"
  /** Leave the keyboard in the new panel (default: it stays where it was). */
  focus?: boolean
}

export interface PanelResult {
  /** A panel is open, or the command is on the clipboard for the person to run. */
  ok: boolean
  /** Nothing was started: the person has to paste the command. */
  manual: boolean
  strategy: TerminalStrategy
  /** The exact line that was typed/copied, for the report. */
  line: string
  detail: string
  /** Ghostty terminal id of the panel, to check later that it is still there. */
  terminalId?: string
}

/** `cd '<cwd>' && echo '[rundev] label' && command`; null when the path cannot be quoted. */
export function buildLine(req: PanelRequest, guard = true): string | null {
  const label = req.label.replaceAll("'", "")
  const body = `echo '[rundev] ${label}' && ${req.command}`
  if (!guard) return body
  const cd = quoteForTyping(req.cwd)
  if (!cd) return null
  return `cd ${cd} && ${body}`
}

/** A cheap, synchronous hint (used in logs); `detectStrategy` is the real answer. */
export function defaultStrategy(platform = process.platform, termProgram = process.env.TERM_PROGRAM): TerminalStrategy {
  return platform === "darwin" && termProgram === "ghostty" ? "ghostty-api" : "clipboard"
}

/** What `openPanel` will do right now, and why. */
export async function detectStrategy(): Promise<{ strategy: TerminalStrategy; detail: string }> {
  const g = await ghosttyStatus()
  return g.ok
    ? { strategy: "ghostty-api", detail: `Ghostty ${g.version} scripting API` }
    : { strategy: "clipboard", detail: g.reason ?? "no scriptable terminal" }
}

async function clipboard(line: string): Promise<{ ok: boolean; detail: string }> {
  // pbcopy reads stdin, and execFile closes it empty — the line must be piped
  // through a shell or the clipboard would end up with nothing.
  const quoted = quoteForTyping(line)
  if (!quoted) return { ok: false, detail: "cannot copy the line safely (it contains quotes)" }
  const r = await run("/bin/sh", ["-lc", `printf %s ${quoted} | pbcopy`], { timeoutMs: 5_000 })
  return r.code === 0
    ? { ok: true, detail: "command copied to the clipboard" }
    : { ok: false, detail: r.err.trim() || "could not copy to the clipboard" }
}

/** Copies the exact panel line, for the launch-time verification fallback. */
export async function copyLine(line: string): Promise<boolean> {
  return (await clipboard(line)).ok
}

async function openWindow(line: string): Promise<{ ok: boolean; detail: string }> {
  if (process.platform !== "darwin") {
    return { ok: false, detail: "the 'open' strategy is only implemented for macOS/Ghostty" }
  }
  const r = await run("/usr/bin/open", ["-na", "Ghostty.app", "--args", "-e", "/bin/zsh", "-lc", line], { timeoutMs: 20_000 })
  return r.code === 0
    ? { ok: true, detail: "new window (separate Ghostty instance)" }
    : { ok: false, detail: r.err.trim() || "could not open the window" }
}

/** Falls back to the clipboard and says why the panel was not opened. */
async function manual(strategy: TerminalStrategy, line: string, why: string): Promise<PanelResult> {
  const copied = await clipboard(line)
  return {
    ok: copied.ok,
    manual: true,
    strategy: "clipboard",
    line,
    detail: copied.ok
      ? `${why} — the command is on the clipboard: open a terminal and paste it (nothing was typed anywhere)`
      : `${why} — and the clipboard failed (${copied.detail}); run it by hand: ${line}`,
  }
}

export async function openPanel(req: PanelRequest): Promise<PanelResult> {
  const strategy = req.strategy ?? (await detectStrategy()).strategy
  const guarded = buildLine(req)

  if (strategy === "ghostty-api") {
    // A fresh split is already in `cwd`; the `cd` guard only matters for a paste.
    const line = guarded ?? buildLine(req, false) ?? req.command
    const terminals = await listTerminals()
    if (!terminals) return manual(strategy, guarded ?? line, "could not read Ghostty's terminals")
    const pick = await pickHostTerminal({ sessionID: req.sessionID, dir: req.dir ?? req.cwd, terminals })
    if (!pick.terminal) return manual(strategy, guarded ?? line, pick.reason)
    const split = await splitTerminal({
      hostId: pick.terminal.id,
      cwd: req.cwd,
      line,
      direction: req.direction,
      focus: req.focus,
    })
    if (!split.ok) return manual(strategy, guarded ?? line, `Ghostty refused the split (${split.detail})`)
    return {
      ok: true,
      manual: false,
      strategy,
      line,
      terminalId: split.terminalId,
      detail: `panel opened ${req.direction ?? "below"} the OpenCode terminal (${pick.reason})${req.focus ? "" : " · keyboard stays where it was"}`,
    }
  }

  if (!guarded) {
    return {
      ok: false,
      manual: true,
      strategy: "clipboard",
      line: "",
      detail: `cannot safely type the path ${req.cwd} (it contains quotes); run it by hand: ${req.command}`,
    }
  }

  if (strategy === "print") {
    return { ok: true, manual: true, strategy, line: guarded, detail: `run it in a terminal: ${guarded}` }
  }

  if (strategy === "open") {
    const r = await openWindow(guarded)
    return { ok: r.ok, manual: false, strategy, line: guarded, detail: r.detail }
  }

  const copied = await clipboard(guarded)
  return {
    ok: copied.ok,
    manual: true,
    strategy: "clipboard",
    line: guarded,
    detail: copied.ok ? "command copied to the clipboard: open a terminal and paste it" : copied.detail,
  }
}
