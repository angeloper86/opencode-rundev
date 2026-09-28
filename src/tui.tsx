/** @jsxImportSource @opentui/solid */
/**
 * tui.tsx — the visible half of rundev.
 *
 *  - Sidebar: a live block with this repo's services and their state, so the
 *    environment is visible at a glance. Cheap checks only (snapshot + pid
 *    liveness): it never runs the engine.
 *  - Reports: the server plugin publishes one `report` event per command to
 *    `.opencode/.rundev/events.jsonl`; we show it in a dialog.
 *  - Progress: the rest of the events become toasts.
 *
 * Read-only by design: it cannot break anything.
 */

import fs from "node:fs"
import path from "node:path"
import { createSignal, For } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"

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

function readSnapshot(dir: string): Snap | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, ".opencode", ".rundev", "status.json"), "utf8"))
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

export default Plugin.define({
  id: "rundev.tui",
  setup(context: Context) {
    const dir: string = context.location?.directory ?? process.cwd()
    const eventsFile = path.join(dir, ".opencode", ".rundev", "events.jsonl")

    // ── live state for the sidebar (setup runs once; the render only reads)
    const [snap, setSnap] = createSignal<Snap | null>(readSnapshot(dir))
    const [tick, setTick] = createSignal(0)
    const poll = setInterval(() => {
      setSnap(readSnapshot(dir))
      setTick((n) => n + 1) // re-evaluate pid liveness
    }, 1500)

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
        const s = snap()
        if (!s || s.services.length === 0) return null
        const theme = context.theme
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

    return () => {
      clearInterval(poll)
      clearInterval(tail)
    }
  },
})
