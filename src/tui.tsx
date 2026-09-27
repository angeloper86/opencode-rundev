/**
 * tui.tsx — the visible half. Reads the events the server plugin publishes
 * (`.opencode/.rundev/events.jsonl`) for the current location and renders them:
 * toasts for progress, a dialog for reports.
 *
 * Read-only by design: it never runs commands, so it can't break anything.
 */

import fs from "node:fs"
import path from "node:path"
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "rundev.tui",
  setup(context: any) {
    const dir: string = context.location?.directory ?? process.cwd()
    const file = path.join(dir, ".opencode", ".rundev", "events.jsonl")

    // Skip history: only show what happens while this TUI is open.
    let offset = 0
    try {
      offset = fs.statSync(file).size
    } catch {
      offset = 0
    }

    const timer = setInterval(() => {
      let size = 0
      try {
        size = fs.statSync(file).size
      } catch {
        return
      }
      if (size < offset) offset = 0
      if (size === offset) return

      let chunk = ""
      try {
        const fd = fs.openSync(file, "r")
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
          void context.ui.dialog.alert({
            title: String(lastReport.title ?? "rundev"),
            message: String(lastReport.text ?? ""),
          })
        } catch {
          /* ignore */
        }
      }
    }, 900)

    return () => clearInterval(timer)
  },
})
