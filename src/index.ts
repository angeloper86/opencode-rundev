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
  async setup(raw) {
    const ctx = raw as unknown as Ctx

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
            `no hay manifiesto rundev para ${dir}. Corré \`/rundev init\` en este repo ` +
            `(crea .opencode/rundev.json) o revisá que estés en la carpeta correcta.`,
        }
      }
      const problems = validate(loaded)
      if (problems.length) return { error: `el manifiesto tiene problemas:\n- ${problems.join("\n- ")}` }
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
      const lines = [`rundev · ${loaded.root}`]
      for (const s of list) {
        const port = s.port ? `:${s.port}` : ""
        const state = s.state === "running" ? "up  " : s.state === "external" ? "ext " : s.state === "error" ? "err " : "down"
        lines.push(`  ${state} ${s.name.padEnd(12)} ${s.kind.padEnd(11)} ${s.detail}${port ? `  ${port}` : ""}`)
        if (s.holders?.length) lines.push(`       ↳ pids en el puerto: ${s.holders.join(", ")} (no los levantó rundev)`)
      }
      return lines.join("\n")
    }

    function upTable(results: E.UpResult[]): string {
      const lines = ["rundev · resultado"]
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
          detail = `ya existe ${path.relative(dir, file)} — no lo toco. Borrador detectado:\n${body}`
        } else {
          const fs = await import("node:fs")
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, `${body}\n`)
          detail = `escribí ${path.relative(dir, file)} (borrador). Revisá los TODO y después /rundev doctor.`
        }
        const notes = s.notes.length ? `\n\nPara completar:\n- ${s.notes.join("\n- ")}` : ""
        return `${detail}${notes}`
      }

      const resolved = resolveManifest(dir)
      if ("error" in resolved) return resolved.error
      const loaded = resolved

      switch (verb) {
        case "status": {
          const list = await E.statusAll(loaded)
          return statusTable(loaded, list)
        }
        case "doctor": {
          const problems = validate(loaded)
          const bins = ["docker", "adb", "xcrun", "osascript", "pbcopy"]
          const found: string[] = []
          for (const b of bins) {
            const r = await E.run("/usr/bin/env", ["sh", "-c", `command -v ${b}`], { timeoutMs: 5_000 })
            found.push(`${b}: ${r.code === 0 ? r.out.trim() : "NO"}`)
          }
          const env = E.envSections(loaded.root)
          return [
            `rundev doctor · ${loaded.root}`,
            `manifiesto: ${path.relative(loaded.root, loaded.file)}${loaded.localApplied ? " (+ rundev.local.json)" : ""}`,
            `servicios: ${Object.keys(loaded.manifest.services).join(", ") || "(ninguno)"}`,
            `problemas: ${problems.length ? `\n- ${problems.join("\n- ")}` : "ninguno ✔"}`,
            `binarios: ${found.join(" · ")}`,
            `env: ${env ? `secciones ${env.sections.join(", ") || "(ninguna)"} · activa: ${env.active ?? "ninguna"}` : "sin .env"}`,
            `terminal: estrategia ${defaultStrategy()}`,
          ].join("\n")
        }
        case "up": {
          const names = services.length ? services : defaultSet(loaded)
          const results = await E.up(loaded, names, {
            waitMs: flagValue(argv, "wait") ? Number(flagValue(argv, "wait")) : undefined,
            targets,
            launch: async (plan) => {
              const strategy = flagValue(argv, "strategy") as TerminalStrategy | undefined
              const r = await openPanel({ cwd: plan.cwd, command: plan.command, label: plan.label, strategy })
              return { ok: r.ok, detail: `${r.detail}${r.ok ? ` → ${r.line}` : ""}` }
            },
          })
          return upTable(results)
        }
        case "down": {
          const names = services.length ? services : defaultSet(loaded)
          const results = await E.down(loaded, names)
          return upTable(results)
        }
        case "logs": {
          const name = services[0]
          if (!name) return "uso: /rundev logs <servicio>"
          const tail = Number(flagValue(argv, "tail") ?? 40)
          return await E.logs(loaded, name, tail)
        }
        case "env": {
          const section = services[0]
          if (!section) {
            const info = E.envSections(loaded.root)
            return info
              ? `secciones: ${info.sections.join(", ") || "(ninguna)"}\nactiva: ${info.active ?? "(ninguna)"}`
              : "este repo no tiene .env"
          }
          const r = E.applyEnvSection(loaded.root, section)
          return r.ok ? r.detail : `no pude cambiar el .env: ${r.detail}`
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
        description: "Entorno de desarrollo del repo: init · up · status · down · logs · doctor · env",
        execute: async ({ sessionID, prompt }: any) => {
          const argv = String(prompt?.text ?? "").trim().split(/\s+/).filter(Boolean)
          const verb = argv[0] ?? "status"
          let report: string
          try {
            report = await execute(verb, argv.slice(1), sessionID)
          } catch (err) {
            report = `rundev falló: ${(err as Error).message}`
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
      editor.namespace({ name: "rundev", description: "Entorno de desarrollo local del repo" })
      editor.add({
        ...toolBase,
        name: "status",
        description:
          "Estado del entorno local: qué servicios están arriba, de quién es cada uno y qué quedó huérfano. No cambia nada.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: await execute("status", []) }),
      })
      editor.add({
        ...toolBase,
        name: "up",
        description:
          "Levanta servicios locales que falten (idempotente). Acepta `servicios` como `app` o `app@ios`. No espera de más.",
        input: {
          type: "object",
          properties: {
            servicios: { type: "array", items: { type: "string" }, description: "Vacío = el default del repo" },
            wait: { type: "number", description: "ms máximos de espera por readiness" },
          },
          additionalProperties: false,
        },
        execute: async (input: any) => {
          const argv = [...(input?.servicios ?? [])]
          if (input?.wait) argv.push(`--wait=${input.wait}`)
          return { content: await execute("up", argv) }
        },
      })
      editor.add({
        ...toolBase,
        name: "down",
        description: "Baja servicios que rundev levantó en este repo. Baja todo lo declarado si no se especifica nada.",
        input: {
          type: "object",
          properties: { servicios: { type: "array", items: { type: "string" } } },
          additionalProperties: false,
        },
        execute: async (input: any) => ({ content: await execute("down", input?.servicios ?? []) }),
      })
      editor.add({
        ...toolBase,
        name: "logs",
        description: "Últimas líneas del log de un servicio del repo.",
        input: {
          type: "object",
          properties: {
            servicio: { type: "string" },
            tail: { type: "number" },
          },
          required: ["servicio"],
          additionalProperties: false,
        },
        execute: async (input: any) => ({
          content: await execute("logs", [input.servicio, ...(input.tail ? [`--tail=${input.tail}`] : [])]),
        }),
      })
    })
  },
})
