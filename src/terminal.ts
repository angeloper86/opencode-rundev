/**
 * terminal.ts — opens a terminal panel/window running a command.
 *
 * Golden rule (learned the hard way): the panel inherits the cwd of whatever
 * surface is focused, so every typed line starts with an absolute
 * `cd '<repo-root>' &&` guard. If the path cannot be safely quoted, we refuse
 * and fall back to the clipboard.
 */

import { run } from "./engine.ts"
import { quoteForAppleScript, quoteForTyping } from "./manifest.ts"

export type TerminalStrategy = "ghostty-split" | "clipboard" | "open"

export interface PanelRequest {
  /** Absolute repo root: the guard. */
  cwd: string
  /** Command to run inside the panel. */
  command: string
  /** Human label shown in the panel header. */
  label: string
  strategy?: TerminalStrategy
}

export interface PanelResult {
  ok: boolean
  strategy: TerminalStrategy
  /** The exact line that was typed/copied, for the report. */
  line: string
  detail: string
}

export function buildLine(req: PanelRequest): string | null {
  const cd = quoteForTyping(req.cwd)
  if (!cd) return null
  const label = req.label.replaceAll("'", "")
  return `cd ${cd} && echo '[rundev] ${label}' && ${req.command}`
}

export function defaultStrategy(platform = process.platform, termProgram = process.env.TERM_PROGRAM): TerminalStrategy {
  if (platform === "darwin" && termProgram === "ghostty") return "ghostty-split"
  if (platform === "darwin") return "clipboard"
  return "clipboard"
}

/** Ghostty: activate → split down (shift+cmd+D) → clear → type → Enter. */
async function ghosttySplit(line: string): Promise<{ ok: boolean; detail: string }> {
  const script = [
    `tell application "Ghostty" to activate`,
    `delay 0.8`,
    `tell application "System Events" to keystroke "d" using {command down, shift down}`,
    `delay 1.5`,
    // defensive clear: harmless in a fresh shell, clears the prompt in a TUI
    `tell application "System Events" to key code 8 using control down`,
    `tell application "System Events" to keystroke ${quoteForAppleScript(line)}`,
    `delay 0.3`,
    `tell application "System Events" to key code 36`,
  ].flatMap((s) => ["-e", s])

  const r = await run("/usr/bin/osascript", script, { timeoutMs: 30_000 })
  if (r.code !== 0) {
    const hint = /not allowed|1002|-1719|accessibility|assistive/i.test(r.err)
      ? "missing Accessibility/Automation permission for the process running osascript"
      : r.err.trim() || "osascript failed"
    return { ok: false, detail: hint }
  }
  return { ok: true, detail: "panel opened below in the active window (shift+cmd+D)" }
}

async function clipboard(line: string): Promise<{ ok: boolean; detail: string }> {
  const r = await run("/usr/bin/pbcopy", [], { timeoutMs: 5_000 })
  if (r.code !== 0) {
    // pbcopy reads stdin; retry through a shell so the line can be piped
    const r2 = await run("/bin/sh", ["-lc", `printf %s ${quoteForTyping(line)} | pbcopy`], { timeoutMs: 5_000 })
    return r2.code === 0
      ? { ok: true, detail: "command copied to the clipboard (press cmd+D and paste)" }
      : { ok: false, detail: "could not copy to the clipboard" }
  }
  return { ok: true, detail: "command copied to the clipboard (press cmd+D and paste)" }
}

async function openWindow(line: string): Promise<{ ok: boolean; detail: string }> {
  if (process.platform !== "darwin") {
    return { ok: false, detail: "the 'open' strategy is only implemented for macOS/Ghostty" }
  }
  const r = await run(
    "/usr/bin/open",
    ["-na", "Ghostty.app", "--args", "-e", "/bin/zsh", "-lc", line],
    { timeoutMs: 20_000 },
  )
  return r.code === 0
    ? { ok: true, detail: "new window (separate Ghostty instance)" }
    : { ok: false, detail: r.err.trim() || "could not open the window" }
}

export async function openPanel(req: PanelRequest): Promise<PanelResult> {
  const strategy = req.strategy ?? defaultStrategy()
  const line = buildLine(req)
  if (!line) {
    return {
      ok: false,
      strategy: "clipboard",
      line: "",
      detail: `cannot safely type the path ${req.cwd} (it contains quotes); run it by hand: ${req.command}`,
    }
  }

  const result =
    strategy === "ghostty-split"
      ? await ghosttySplit(line)
      : strategy === "open"
        ? await openWindow(line)
        : await clipboard(line)

  return { ok: result.ok, strategy, line, detail: result.detail }
}
