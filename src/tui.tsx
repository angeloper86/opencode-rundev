/** @jsxImportSource @opentui/solid */
/**
 * tui.tsx — the visible half of rundev.
 *
 *  - Sidebar: live state of this repo's services (snapshot + pid liveness).
 *  - Picker: at a workspace root, `/rundev up` opens a checkbox multi-select and
 *    dispatches the chosen members to the server command.
 *  - Reports open in a dialog; progress shows up as toasts.
 *
 * It never runs the engine: it only reads local files and forwards commands.
 */

import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { createSignal, For } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { findManifest, findWorkspace, workspaceMembers, type Loaded } from "./manifest.ts"

interface SnapService {
  name: string
  kind: string
  state: string
  detail: string
  port?: number
  pid?: number
}

interface Snap {
  ts: number
  root: string
  services: SnapService[]
}

interface PickerRow {
  name: string
  detail: string
}

function readSnapshot(root: string): Snap | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ".opencode", ".rundev", "status.json"), "utf8"))
  } catch {
    return null
  }
}

function alive(pid?: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A service is live if its recorded pid still exists. */
function isLive(svc: SnapService): boolean {
  if (svc.kind === "process" || svc.kind === "interactive") return svc.state === "running" && alive(svc.pid)
  return svc.state === "running"
}

/** One line describing a member's services and their last known state. */
function describeMember(member: { name: string; loaded: Loaded }): string {
  const snap = readSnapshot(member.loaded.root)
  return Object.keys(member.loaded.manifest.services)
    .map((name) => {
      const found = snap?.services.find((s) => s.name === name)
      const mark = found?.state === "running" ? "●" : found?.state === "unhealthy" ? "!" : "○"
      return `${mark} ${name}`
    })
    .join("  ")
}

/** `bankyto-api` inside workspace `bankyto` → `api` (compact sidebar rows). */
function shortMember(member: string, workspace: string): string {
  for (const sep of ["-", "_", "."]) {
    const prefix = `${workspace}${sep}`.toLowerCase()
    if (member.toLowerCase().startsWith(prefix)) return member.slice(prefix.length)
  }
  return member
}

export default Plugin.define({
  id: "rundev.tui",
  setup(context: Context) {
    const dir: string = context.location?.directory ?? process.cwd()
    const eventsFile = path.join(dir, ".opencode", ".rundev", "events.jsonl")
    const theme = context.theme
    // the theme's own accent for a focused surface (fallback: its base variant)
    const highlight = theme.background.action.primary.state({ focused: true })
    const highlightBase = theme.background.action.primary.base

    // ── live state for the sidebar: the repo, or every member at a workspace root
    const workspace = (() => {
      const ws = findWorkspace(dir)
      if (!ws || findManifest(dir)) return null
      return { name: ws.workspace.name ?? path.basename(ws.root), members: workspaceMembers(ws) }
    })()
    const [snap, setSnap] = createSignal<Snap | null>(readSnapshot(dir))
    const [members, setMembers] = createSignal<Array<{ name: string; services: SnapService[] }>>(
      (workspace?.members ?? []).map((m) => ({ name: m.name, services: readSnapshot(m.loaded.root)?.services ?? [] })),
    )
    const [tick, setTick] = createSignal(0)
    const poll = setInterval(() => {
      if (workspace) {
        setMembers(
          workspace.members.map((m) => ({ name: m.name, services: readSnapshot(m.loaded.root)?.services ?? [] })),
        )
      } else {
        setSnap(readSnapshot(dir))
      }
      setTick((n) => n + 1)
    }, 1500)

    // ── checkbox picker (workspace members)
    const [picker, setPicker] = createSignal<{ verb: string; title: string; rows: PickerRow[] } | null>(null)
    const [cursor, setCursor] = createSignal(0)
    const [checked, setChecked] = createSignal<Set<string>>(new Set())

    function currentSessionID(): string | undefined {
      try {
        const route: any = context.ui.router.current()
        return route.type === "session" && route.sessionID ? route.sessionID : undefined
      } catch {
        return undefined
      }
    }

    /** Forwards a rundev invocation to the server command, with a CLI fallback. */
    async function dispatch(text: string): Promise<void> {
      const sessionID = currentSessionID()
      if (!sessionID) {
        context.ui.toast.show({ variant: "warning", title: "rundev", message: "open a session first", duration: 3000 })
        return
      }
      try {
        const client: any = context.client
        const res = await client?.session?.command?.({ sessionID, name: "rundev", text })
        if (res !== undefined) return
      } catch {
        /* fall through to the CLI */
      }
      try {
        const child = spawn(
          "opencode",
          ["api", "post", `/api/session/${sessionID}/command`, "--data", JSON.stringify({ name: "rundev", text })],
          { detached: true, stdio: "ignore" },
        )
        child.unref()
      } catch {
        context.ui.toast.show({ variant: "error", title: "rundev", message: "could not reach the server", duration: 4000 })
      }
    }

    function cancelPicker(): void {
      if (!picker()) return
      context.ui.dialog.clear()
      setPicker(null)
    }

    function confirmPicker(): void {
      const p = picker()
      if (!p) return
      const chosen = p.rows.filter((r) => checked().has(r.name)).map((r) => r.name)
      context.ui.dialog.clear()
      setPicker(null)
      if (chosen.length === 0) return
      void dispatch(`${p.verb} ${chosen.join(" ")}`)
    }

    function openPicker(verb: string, title: string, rows: PickerRow[]): void {
      setChecked(new Set(rows.map((r) => r.name)))
      setCursor(0)
      setPicker({ verb, title, rows })
      context.ui.dialog.set({ size: "large", centered: true })
      context.ui.dialog.show(
        () => (
          <box flexDirection="column">
            <text fg={theme.text.base}>
              <b>{`  RUNDEV - ${picker()?.title ?? ""}`}</b>
            </text>
            <text fg={theme.text.muted}>{` `}</text>
            <For each={picker()?.rows ?? []}>
              {(row, i) => {
                const focused = () => i() === cursor()
                const mark = () => (checked().has(row.name) ? "[x]" : "[ ]")
                // wide enough for every row, so the highlight reads as a bar
                const rowWidth = () => {
                  const rows = picker()?.rows ?? []
                  return Math.max(30, ...rows.map((r) => r.name.length + r.detail.length + 8))
                }
                return (
                  <box width="100%" height={1} backgroundColor={focused() ? highlightBase : undefined}>
                    <text fg={focused() ? theme.background.base : theme.text.base} bg={focused() ? highlight : undefined}>
                      {`${focused() ? "❯" : " "} ${mark()} ${row.name.padEnd(16)} ${row.detail}`.padEnd(rowWidth())}
                    </text>
                  </box>
                )
              }}
            </For>
            <text fg={theme.text.muted}>{` `}</text>
            <text
              fg={theme.text.muted}
            >{`  space toggle · enter ${picker()?.verb ?? "up"} (${checked().size} selected) · esc cancel`}</text>
            <text fg={theme.text.muted}>{` `}</text>
          </box>
        ),
        () => setPicker(null),
      )
    }

    // ── reports + progress published by the server plugin
    let offset = 0
    try {
      offset = fs.statSync(eventsFile).size // skip history
    } catch {
      offset = 0
    }
    const tail = setInterval(() => {
      let size = 0
      try {
        size = fs.statSync(eventsFile).size
      } catch {
        return
      }
      if (size < offset) offset = 0
      if (size === offset) return

      let chunk = ""
      try {
        const fd = fs.openSync(eventsFile, "r")
        const buf = Buffer.alloc(size - offset)
        fs.readSync(fd, buf, 0, buf.length, offset)
        fs.closeSync(fd)
        chunk = buf.toString("utf8")
      } catch {
        return
      }
      offset = size

      let lastReport: any = null
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue
        let ev: any
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (ev.type === "report") {
          lastReport = ev
          continue
        }
        try {
          context.ui.toast.show({
            title: ev.service ? `rundev · ${ev.service}` : "rundev",
            message: String(ev.message ?? ""),
            variant:
              ev.level === "error"
                ? "error"
                : ev.level === "warn"
                  ? "warning"
                  : ev.level === "ok"
                    ? "success"
                    : "info",
            duration: 2600,
          })
        } catch {
          /* ignore */
        }
      }

      if (lastReport) {
        try {
          context.ui.dialog.set({ size: "large" })
          void context.ui.dialog.alert({
            title: String(lastReport.title ?? "rundev"),
            message: String(lastReport.text ?? ""),
          })
        } catch {
          /* ignore */
        }
      }
    }, 900)

    // ── sidebar block
    context.ui.slot({
      append: "sidebar.content",
      render: () => {
        if (workspace) {
          const rows = members()
          if (rows.length === 0) return null
          const width = Math.max(...rows.map((r) => shortMember(r.name, workspace.name).length))
          return (
            <box flexDirection="column" paddingLeft={1}>
              <text fg={theme.text.base}>
                <b>RUNDEV</b>
                {` - ${workspace.name}`}
              </text>
              <For each={rows}>
                {(member) => (
                  <box flexDirection="row">
                    <text fg={theme.text.muted}>{`${shortMember(member.name, workspace.name).padEnd(width)} `}</text>
                    <For each={member.services}>
                      {(svc) => {
                        const live = () => {
                          tick()
                          return isLive(svc)
                        }
                        return (
                          <text fg={live() ? theme.text.feedback.success.base : theme.text.muted}>
                            {` ${live() ? "●" : "○"}${svc.name}`}
                          </text>
                        )
                      }}
                    </For>
                  </box>
                )}
              </For>
            </box>
          )
        }
        const s = snap()
        if (!s || s.services.length === 0) return null
        return (
          <box flexDirection="column" paddingLeft={1}>
            <text fg={theme.text.base}>
              <b>RUNDEV</b>
              {` - ${path.basename(s.root)}`}
            </text>
            <For each={s.services}>
              {(svc) => {
                const live = () => {
                  tick()
                  return isLive(svc)
                }
                return (
                  <text fg={live() ? theme.text.feedback.success.base : theme.text.muted}>
                    {`${live() ? "●" : "○"} ${svc.name}${svc.port ? ` :${svc.port}` : ""} ${live() ? "up" : svc.state}`}
                  </text>
                )
              }}
            </For>
          </box>
        )
      },
    })

    // ── command surface (registered from a component scope, as the keymap requires)
    context.ui.slot({
      append: "app",
      render: () => {
        // picker keys: inert unless the picker is open
        context.keymap.layer(() => ({
          mode: "global",
          priority: 100,
          commands: [
            {
              id: "rundev.picker.up",
              bind: "up",
              run: () => {
                if (!picker()) return false
                setCursor((n) => Math.max(0, n - 1))
              },
            },
            {
              id: "rundev.picker.down",
              bind: "down",
              run: () => {
                const p = picker()
                if (!p) return false
                setCursor((n) => Math.min(p.rows.length - 1, n + 1))
              },
            },
            {
              id: "rundev.picker.toggle",
              bind: "space",
              run: () => {
                const p = picker()
                if (!p) return false
                const next = new Set(checked())
                const name = p.rows[cursor()]?.name
                if (!name) return
                if (next.has(name)) next.delete(name)
                else next.add(name)
                setChecked(next)
              },
            },
            {
              id: "rundev.picker.ok",
              bind: "return",
              run: () => {
                if (!picker()) return false
                confirmPicker()
              },
            },
            {
              id: "rundev.picker.cancel",
              bind: "escape",
              run: () => {
                if (!picker()) return false
                cancelPicker()
              },
            },
          ],
          bindings: [
            "rundev.picker.up",
            "rundev.picker.down",
            "rundev.picker.toggle",
            "rundev.picker.ok",
            "rundev.picker.cancel",
          ],
        }))

        // `/rundev …`: forwards to the server, or opens the picker at a workspace root
        context.keymap.layer(() => ({
          mode: "global",
          priority: 10,
          commands: [
            {
              id: "rundev.command",
              title: "rundev",
              description: "Dev environment of the repo (or pick workspace members)",
              group: "Plugin",
              palette: true,
              slash: { name: "rundev", arguments: true },
              run: (input?: string) => {
                const text = String(input ?? "").trim()
                const words = text.split(/\s+/).filter(Boolean)
                const verb = words[0] || "status"
                const rest = words.slice(1)
                const here = context.location?.directory ?? process.cwd()
                const ws = findWorkspace(here)
                const atWorkspaceRoot = Boolean(ws) && !findManifest(here)
                const members = atWorkspaceRoot && ws ? workspaceMembers(ws) : []
                const namesMember = rest.some((r) => members.some((m) => m.name === r))
                const wantsPicker =
                  atWorkspaceRoot &&
                  members.length > 0 &&
                  ["up", "down", "status"].includes(verb) &&
                  !namesMember &&
                  !text.includes("--all")

                if (wantsPicker) {
                  openPicker(
                    verb,
                    ws!.workspace.name ?? path.basename(ws!.root),
                    members.map((m) => ({ name: m.name, detail: describeMember(m) })),
                  )
                  return
                }
                void dispatch(text || "status")
              },
            },
          ],
          bindings: ["rundev.command"],
        }))

        return null
      },
    })

    return () => {
      clearInterval(poll)
      clearInterval(tail)
    }
  },
})
