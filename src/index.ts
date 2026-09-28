/**
 * index.ts — the server plugin: one command for the user, tools for the agent.
 *
 * The command does the work and publishes its output through
 * `.opencode/.rundev/events.jsonl`; the TUI plugin renders it (toasts +
 * dialog). Nothing is sent to the model, so `/rundev` costs zero tokens.
 */

import { Plugin } from "@opencode/plugin"
import path from "node:path"
import { defaultSet, findManifest, validate, type Loaded } from "./manifest.ts"
import * as E from "./engine.ts"
import { scan } from "./scan.ts"
import { defaultStrategy, openPanel, type TerminalStrategy } from "./terminal.ts"

interface Ctx {
  location?: { directory?: string }
  session: { get(input: { sessionID: string }, requestOptions?: unknown): Promise<any> }
  command: { transform(cb: (editor: any) => void): Promise<unknown> }
  tool: { transform(cb: (editor: any) => void): Promise<unknown> }
}

export default Plugin.define({
  id: "rundev",
  async setup(ctx) {

    // ── location + manifest resolution ─────────────────────────────────────
    async function locationFor(sessionID?: string): Promise<string> {
      if (sessionID) {
        try {
          const s: any = await ctx.session.get({ sessionID })
          const dir = s?.location?.directory ?? s?.data?.location?.directory
          if (dir) return dir
        } catch {
          /* fall through */
        }
      }
      return ctx.location?.directory ?? process.cwd()
    }

    function resolveManifest(dir: string): Loaded | { error: string } {
      const loaded = findManifest(dir)
      if (!loaded) {
        return {
          error:
            `no rundev manifest for ${dir}. Run \`/rundev init\` in this repo ` +
            `(it creates .opencode/rundev.json) or check that you are in the right folder.`,
        }
      }
      const problems = validate(loaded)
      if (problems.length) return { error: `the manifest has problems:\n- ${problems.join("\n- ")}` }
      return loaded
    }

    function parseArgs(argv: string[]) {
      const services: string[] = []
      const targets: Record<string, string> = {}
      const flags = new Set<string>()
      for (const a of argv) {
        if (a.startsWith("--")) {
          flags.add(a.slice(2))
          continue
        }
        const [name, target] = a.split("@")
        services.push(name)
        if (target) targets[name] = target
      }
      return { services, targets, flags }
    }

    function flagValue(argv: string[], name: string): string | undefined {
      const hit = argv.find((a) => a.startsWith(`--${name}=`))
      return hit ? hit.slice(name.length + 3) : undefined
    }

    // ── reports ────────────────────────────────────────────────────────────
    function statusTable(loaded: Loaded, list: E.ServiceStatus[]): string {
      const lines = [`rundev · ${path.basename(loaded.root)}`]
      const icon = (s: E.ServiceStatus) =>
        s.state === "running"
          ? "●"
          : s.state === "unhealthy"
            ? "!"
            : s.state === "external"
              ? "ext"
              : s.state === "error"
                ? "err"
                : "○"
      for (const s of list) {
        const port = s.port ? `:${s.port}` : ""
        lines.push(
          `  ${icon(s).padEnd(3)} ${s.name.padEnd(11)} ${s.kind.padEnd(10)} ${port.padEnd(6)} ${s.state} · ${s.detail}`,
        )
        if (s.holders?.length) lines.push(`      ↳ pids on the port: ${s.holders.join(", ")} (not started by rundev)`)
      }
      return lines.join("\n")
    }

    function upTable(results: E.UpResult[]): string {
      const lines = ["rundev · result"]
      const icon = (a: E.UpResult["action"]) =>
        a === "started" ? "ok " : a === "stopped" ? "ok " : a === "already" ? "=" : a === "failed" ? "ERR" : a === "blocked" ? "!" : "-"
      for (const r of results) {
        lines.push(`  ${icon(r.action)} ${r.name.padEnd(12)} ${r.action.padEnd(8)} ${r.detail}`)
      }
      return lines.join("\n")
    }

    // ── one entry point for command + tools ────────────────────────────────
    async function execute(verb: string, argv: string[], sessionID?: string): Promise<string> {
      const dir = await locationFor(sessionID)
      const { services, targets } = parseArgs(argv)

      if (verb === "init") {
        const s = scan(dir)
        const file = path.join(dir, ".opencode", "rundev.json")
        const exists = (await import("node:fs")).existsSync(file)
        const body = JSON.stringify(s.draft, null, 2)
        let detail: string
        if (exists) {
          detail = `${path.relative(dir, file)} already exists — leaving it alone. This is what I detect now:\n\n${body}`
        } else {
          const fs = await import("node:fs")
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, `${body}\n`)
          detail = `wrote ${path.relative(dir, file)}. Review and adjust what the scan cannot know:\n\n${body}`
        }
        const notes = s.notes.length ? `\n\nTo complete:\n- ${s.notes.join("\n- ")}` : ""
        // light the sidebar right away (snapshot of what is already running)
        const after = findManifest(dir)
        if (after) {
          try {
            await E.statusAll(after)
          } catch {
            /* ignore */
          }
        }
        return `${detail}${notes}`
      }

      const resolved = resolveManifest(dir)
      if ("error" in resolved) return resolved.error
      const loaded = resolved

      switch (verb) {
        case "status": {
          E.emit(loaded.root, { type: "event", level: "info", message: "checking…" })
          const list = await E.statusAll(loaded)
          return statusTable(loaded, list)
        }
        case "doctor": {
          const problems = validate(loaded)
          const svcs = Object.values(loaded.manifest.services)
          const kinds = new Set(svcs.map((s) => s.kind))
          const need = new Set<string>()
          if (kinds.has("compose")) need.add("docker")
          if (kinds.has("interactive")) {
            need.add("osascript")
            need.add("pbcopy")
          }
          const devices = svcs
            .flatMap((s) => Object.values(s.targets ?? {}).map((t) => `${t.device ?? ""} ${t.envSection ?? ""}`))
            .join(" ")
            .toLowerCase()
          if (/android|emulator|pixel/.test(devices)) need.add("adb")
          if (/ios|iphone|ipad|simulator/.test(devices)) need.add("xcrun")
          const found: string[] = []
          for (const b of need) {
            const r = await E.run("/usr/bin/env", ["sh", "-c", `command -v ${b}`], { timeoutMs: 5_000 })
            found.push(`${b} ${r.code === 0 ? "✔" : "✗"}`)
          }
          const env = E.envSections(loaded.root)
          return [
            `rundev doctor · ${path.basename(loaded.root)}`,
            `manifest: ${path.relative(loaded.root, loaded.file)}${loaded.localApplied ? " (+ rundev.local.json)" : ""}`,
            `services: ${Object.keys(loaded.manifest.services).join(", ") || "(none)"}`,
            `problems: ${problems.length ? `\n- ${problems.join("\n- ")}` : "none ✔"}`,
            `binaries: ${found.length ? found.join(" · ") : "(none needed)"}`,
            `env: ${env ? `sections ${env.sections.join(", ") || "(none)"} · active: ${env.active ?? "none"}` : "no .env"}`,
            `terminal: strategy ${defaultStrategy()}`,
          ].join("\n")
        }
        case "up": {
          const names = services.length ? services : defaultSet(loaded)
          const t0 = Date.now()
          const results = await E.up(loaded, names, {
            waitMs: flagValue(argv, "wait") ? Number(flagValue(argv, "wait")) : undefined,
            targets,
            launch: async (plan) => {
              const strategy = flagValue(argv, "strategy") as TerminalStrategy | undefined
              const r = await openPanel({ cwd: plan.cwd, command: plan.command, label: plan.label, strategy })
              return { ok: r.ok, detail: `${r.detail}${r.ok ? ` → ${r.line}` : ""}` }
            },
          })
          return `${upTable(results)}\n\n(${((Date.now() - t0) / 1000).toFixed(1)}s)`
        }
        case "down": {
          const names = services.length ? services : defaultSet(loaded)
          const t0 = Date.now()
          const results = await E.down(loaded, names)
          return `${upTable(results)}\n\n(${((Date.now() - t0) / 1000).toFixed(1)}s)`
        }
        case "logs": {
          const name = services[0]
          if (!name) return "usage: /rundev logs <service>"
          const tail = Number(flagValue(argv, "tail") ?? 40)
          return await E.logs(loaded, name, tail)
        }
        case "env": {
          const section = services[0]
          if (!section) {
            const info = E.envSections(loaded.root)
            return info
              ? `secciones: ${info.sections.join(", ") || "(ninguna)"}\nactiva: ${info.active ?? "(ninguna)"}`
              : "this repo has no .env"
          }
          const r = E.applyEnvSection(loaded.root, section)
          return r.ok ? r.detail : `could not change .env: ${r.detail}`
        }
        default:
          return (
            `verbos: init · up · status · down · logs · doctor · env\n` +
            `ejemplos:\n  /rundev up\n  /rundev up app@ios\n  /rundev down --all\n  /rundev logs api`
          )
      }
    }

    // ── user-facing command ────────────────────────────────────────────────
    await ctx.command.transform((editor) => {
      editor.add({
        name: "rundev",
        description: "Repo dev environment: init · up · status · down · logs · doctor · env",
        execute: async ({ sessionID, prompt }: any) => {
          const argv = String(prompt?.text ?? "").trim().split(/\s+/).filter(Boolean)
          const verb = argv[0] ?? "status"
          let report: string
          try {
            report = await execute(verb, argv.slice(1), sessionID)
          } catch (err) {
            report = `rundev failed: ${(err as Error).message}`
          }
          E.emit(await locationFor(sessionID).then((d) => findManifest(d)?.root ?? d), {
            type: "report",
            title: `rundev ${verb}`,
            text: report,
          })
        },
      })
    })

    // ── agent tools ────────────────────────────────────────────────────────
    const toolBase = {
      options: { namespace: "rundev", codemode: true },
    }
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "rundev", description: "Local dev environment of the repo" })
      editor.add({
        ...toolBase,
        name: "status",
        description:
          "Local environment status: what is up, who owns it, and what was left orphaned. Changes nothing.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: await execute("status", []) }),
      })
      editor.add({
        ...toolBase,
        name: "up",
        description:
          "Starts missing local services (idempotent). Accepts `services` as `app` or `app@ios`. Does not over-wait.",
        input: {
          type: "object",
          properties: {
            services: { type: "array", items: { type: "string" }, description: "Empty = the repo default" },
            wait: { type: "number", description: "max ms to wait for readiness" },
          },
          additionalProperties: false,
        },
        execute: async (input: any) => {
          const argv = [...(input?.services ?? [])]
          if (input?.wait) argv.push(`--wait=${input.wait}`)
          return { content: await execute("up", argv) }
        },
      })
      editor.add({
        ...toolBase,
        name: "down",
        description: "Stops services rundev started in this repo. With no argument it stops everything declared.",
        input: {
          type: "object",
          properties: { services: { type: "array", items: { type: "string" } } },
          additionalProperties: false,
        },
        execute: async (input: any) => ({ content: await execute("down", input?.services ?? []) }),
      })
      editor.add({
        ...toolBase,
        name: "logs",
        description: "Last lines of a repo service log.",
        input: {
          type: "object",
          properties: {
            service: { type: "string" },
            tail: { type: "number" },
          },
          required: ["service"],
          additionalProperties: false,
        },
        execute: async (input: any) => ({
          content: await execute("logs", [input.service, ...(input.tail ? [`--tail=${input.tail}`] : [])]),
        }),
      })
    })
  },
})
