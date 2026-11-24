/** @jsxImportSource @opentui/solid */
/**
 * tui.tsx — the visible half of rundev.
 *
 *  - Sidebar: live state of this repo's services (snapshot + pid liveness).
 *  - Picker: at a workspace root the server command emits a `select` event and this
 *    side opens a checkbox multi-select, then re-dispatches the chosen members.
 *  - Reports open in a dialog; progress shows up as toasts.
 *
 * It never runs the engine: it only reads local files and forwards commands.
 */

import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { createSignal, For, Show } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { registerClient, ttyOfPid, unregisterClient } from "./clients.ts"
import { dependencyOrder, findManifest, findWorkspace, memberOf, workspaceMembers, type Loaded } from "./manifest.ts"

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
  for (const target of [pid, -pid]) {
    // the leader, or — when it exited and its children kept serving — the group
    try {
      process.kill(target, 0)
      return true
    } catch (err: any) {
      if (err?.code === "EPERM") return true
    }
  }
  return false
}

/**
 * A service is live if its recorded pid still exists. Interactive panels have no
 * pid: there the state the engine recorded (it asks the terminal itself) is all there is.
 */
function isLive(svc: SnapService): boolean {
  if (svc.kind === "process") return (svc.state === "running" || svc.state === "starting") && alive(svc.pid)
  return svc.state === "running" || svc.state === "starting"
}

/** One line describing a member's services and their last known state. */
function describeMember(member: { name: string; loaded: Loaded }): string {
  const snap = readSnapshot(member.loaded.root)
  return Object.keys(member.loaded.manifest.services)
    .map((name) => {
      const found = snap?.services.find((s) => s.name === name)
      const mark =
        found?.state === "running" ? "●" : found?.state === "starting" ? "…" : found?.state === "unhealthy" ? "!" : "○"
      return `${mark} ${name}`
    })
    .join("  ")
}

export default Plugin.define({
  id: "rundev.tui",
  setup(context: Context) {
    const dir: string = context.location?.directory ?? process.cwd()
    const theme = context.theme
    // the theme's own accent for a focused surface (fallback: its base variant)
    const highlight = theme.background.action.primary.state({ focused: true })
    const highlightBase = theme.background.action.primary.base

    // The engine writes its state at the MANIFEST root, which is not where OpenCode
    // was opened when that is a subfolder of the repo (apps/web of a monorepo).
    const own = findManifest(dir)
    const home = own?.root ?? dir
    const ws = findWorkspace(dir)

    // ── live state for the sidebar: the repo, or every member at a workspace root
    const workspace = (() => {
      if (!ws || own) return null
      return { name: ws.workspace.name ?? path.basename(ws.root), members: workspaceMembers(ws) }
    })()
    // Inside a member, what its `up` brings up first lives in other repos: follow them too.
    const dependencies = (() => {
      const me = ws && own ? memberOf(ws, own.root) : undefined
      if (!ws || !me) return []
      const all = workspaceMembers(ws)
      return dependencyOrder(ws, me).flatMap((name) => all.filter((m) => m.name === name))
    })()
    const [snap, setSnap] = createSignal<Snap | null>(readSnapshot(home))
    const [members, setMembers] = createSignal<Array<{ name: string; services: SnapService[] }>>(
      (workspace?.members ?? []).map((m) => ({ name: m.name, services: readSnapshot(m.loaded.root)?.services ?? [] })),
    )
    const [depBlocks, setDepBlocks] = createSignal<Array<{ name: string; services: SnapService[] }>>(
      dependencies.map((m) => ({ name: m.name, services: readSnapshot(m.loaded.root)?.services ?? [] })),
    )
    const [tick, setTick] = createSignal(0)
    const poll = setInterval(() => {
      if (workspace) {
        setMembers(
          workspace.members.map((m) => ({ name: m.name, services: readSnapshot(m.loaded.root)?.services ?? [] })),
        )
      } else {
        setSnap(readSnapshot(home))
        if (dependencies.length) {
          setDepBlocks(dependencies.map((m) => ({ name: m.name, services: readSnapshot(m.loaded.root)?.services ?? [] })))
        }
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
      // Primary path: the client. `session.command` resolves to `void`, so the
      // only thing worth checking is that the client exposes it at all — a
      // return-value test (`res !== undefined`) is always false and falls
      // through to the CLI as well, running the verb twice.
      const client: any = context.client
      if (client?.session?.command) {
        try {
          await client.session.command({ sessionID, name: "rundev", text })
          return
        } catch {
          /* unreachable server: fall through to the CLI */
        }
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
    // In workspace mode every member publishes to its own repo: read them all,
    // otherwise a member started from this session reports into the void.
    const eventsFileFor = (root: string) => path.join(root, ".opencode", ".rundev", "events.jsonl")
    const eventRoots = workspace
      ? [dir, ...workspace.members.map((m) => m.loaded.root)]
      : [home, ...dependencies.map((m) => m.loaded.root)]
    const offsets = new Map<string, number>()
    for (const root of eventRoots) {
      const file = eventsFileFor(root)
      try {
        offsets.set(file, fs.statSync(file).size) // skip history
      } catch {
        offsets.set(file, 0)
      }
    }

    /** New event lines across every repo of this location. */
    function drainEvents(): any[] {
      const out: any[] = []
      for (const [file, seen] of offsets) {
        let size = 0
        try {
          size = fs.statSync(file).size
        } catch {
          continue
        }
        let offset = seen
        if (size < offset) offset = 0
        if (size === offset) continue
        let chunk = ""
        try {
          const fd = fs.openSync(file, "r")
          const buf = Buffer.alloc(size - offset)
          fs.readSync(fd, buf, 0, buf.length, offset)
          fs.closeSync(fd)
          chunk = buf.toString("utf8")
        } catch {
          continue
        }
        offsets.set(file, size)
        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue
          try {
            out.push(JSON.parse(line))
          } catch {
            /* ignore a half line */
          }
        }
      }
      return out
    }

    const tail = setInterval(() => {
      const events = drainEvents()
      if (events.length === 0) return

      let lastReport: any = null
      let selectRequested = false
      for (const ev of events) {
        if (ev.type === "report") {
          lastReport = ev
          continue
        }
        if (ev.type === "select") {
          // The server command asked for a member selection: only this session's TUI answers.
          const asked = String(ev.sessionID ?? "")
          const mine = currentSessionID() ?? ""
          if (asked && mine && asked !== mine) continue
          const rows = (Array.isArray(ev.members) ? (ev.members as string[]) : []).map((name) => {
            const member = workspace?.members.find((m) => m.name === name)
            return { name, detail: member ? describeMember(member) : "" }
          })
          if (rows.length > 0) {
            openPicker(String(ev.verb ?? "up"), String(ev.workspace ?? workspace?.name ?? "workspace"), rows)
            selectRequested = true
          }
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

      if (lastReport && !selectRequested && !picker()) {
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
          // one block per repo, only repos with something running
          const blocks = members().filter((m) => m.services.some((svc) => {
            tick()
            return isLive(svc)
          }))
          if (blocks.length === 0) return null
          return (
            <box flexDirection="column" paddingLeft={1}>
              <For each={blocks}>
                {(member, i) => (
                  <box flexDirection="column">
                    <Show when={i() > 0}>
                      <text fg={theme.text.muted}>{` `}</text>
                    </Show>
                    <text fg={theme.text.base}>
                      <b>{`RUNDEV - ${member.name}`}</b>
                    </text>
                    <For each={member.services}>
                      {(svc) => {
                        const live = () => {
                          tick()
                          return isLive(svc)
                        }
                        return (
                          <text fg={live() ? theme.text.feedback.success.base : theme.text.muted}>
                            {`● ${svc.name}${svc.port ? ` :${svc.port}` : ""} ${live() ? "up" : svc.state}`}
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
        // the repos its `up` brings up first, only while they have something running
        const deps = depBlocks().filter((m) =>
          m.services.some((svc) => {
            tick()
            return isLive(svc)
          }),
        )
        if ((!s || s.services.length === 0) && deps.length === 0) return null
        return (
          <box flexDirection="column" paddingLeft={1}>
            <Show when={s && s.services.length > 0}>
              <text fg={theme.text.base}>
                <b>RUNDEV</b>
                {` - ${path.basename(s?.root ?? home)}`}
              </text>
              <For each={s?.services ?? []}>
                {(svc) => {
                  const live = () => {
                    tick()
                    return isLive(svc)
                  }
                  return (
                    <text fg={live() ? theme.text.feedback.success.base : theme.text.muted}>
                      {`${live() ? "●" : "○"} ${svc.name}${svc.port ? ` :${svc.port}` : ""} ${live() ? (svc.state === "starting" ? "starting" : "up") : svc.state}`}
                    </text>
                  )
                }}
              </For>
            </Show>
            <For each={deps}>
              {(member) => (
                <box flexDirection="column">
                  <text fg={theme.text.muted}>{` `}</text>
                  <text fg={theme.text.base}>
                    <b>{`RUNDEV - ${member.name}`}</b>
                  </text>
                  <For each={member.services}>
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
              )}
            </For>
          </box>
        )
      },
    })

    // ── picker keys (registered from a component scope, as the keymap requires)
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

        return null
      },
    })

    // ── tell the server which terminal this session lives in, so a panel opens next
    // to it and never "wherever the focus happens to be"
    const tty = ttyOfPid(process.pid)
    let announced: string | undefined | null = null
    const announce = () => {
      const sessionID = currentSessionID()
      if (announced === sessionID) return
      announced = sessionID
      registerClient({ pid: process.pid, tty, dir, sessionID })
    }
    announce()
    const announcer = setInterval(announce, 1500)
    const goodbye = () => unregisterClient(process.pid)
    process.once("exit", goodbye)

    return () => {
      clearInterval(poll)
      clearInterval(tail)
      clearInterval(announcer)
      goodbye()
    }
  },
})
