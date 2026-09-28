/**
 * harness.ts — dev-only. Loads the plugin with a mock context (no OpenCode
 * server, no LLM) and exercises one thing:
 *
 *   node --experimental-strip-types dev/harness.ts <dir> "<verb> [args]"
 *   node --experimental-strip-types dev/harness.ts <dir> "tool:<name>" '{"input": ...}'
 */

import plugin from "../src/index.ts"

const dir = process.argv[2] ?? process.cwd()
const task = process.argv[3] ?? "status"
const toolJSON = process.argv[4] ?? "{}"

const commands: any[] = []
const tools: any[] = []
const namespaces: any[] = []
const skills: any[] = []
const prompts: string[] = []
const skills_seen: string[] = []

const mockCtx: any = {
  location: { directory: dir },
  session: {
    get: async () => ({ location: { directory: dir } }),
    prompt: async (input: any) => {
      prompts.push(String(input?.text ?? ""))
      return { id: "msg_mock" }
    },
  },
  command: { transform: async (cb: any) => cb({ add: (d: any) => commands.push(d) }) },
  tool: {
    transform: async (cb: any) =>
      cb({ namespace: (n: any) => namespaces.push(n), add: (t: any) => tools.push(t) }),
  },
  skill: { transform: async (cb: any) => cb({ add: (s: any) => skills.push(s) }) },
}

await (plugin as any).setup(mockCtx)

console.log("comando:", commands.map((c) => c.name).join(", ") || "(ninguno)")
console.log("tools:", tools.map((t) => t.name).join(", ") || "(ninguno)")
console.log("skills:", skills.map((s) => s.id).join(", ") || "(ninguno)")
void skills_seen

if (task.startsWith("tool:")) {
  const name = task.slice(5)
  const tool = tools.find((t) => t.name === name)
  if (!tool) {
    console.log(`✗ no such tool: ${name}`)
    process.exit(1)
  }
  const result = await tool.execute(JSON.parse(toolJSON), {})
  console.log(`\n--- tool ${name}`)
  console.log(typeof result === "string" ? result : (result?.content ?? JSON.stringify(result)))
  process.exit(0)
}

const cmd = commands.find((c) => c.name === "rundev")
if (!cmd) {
  console.log("✗ the rundev command was not registered")
  process.exit(1)
}
console.log(`\n--- rundev ${task}`)
await cmd.execute({ sessionID: "ses_mock", prompt: { text: task }, delivery: "steer" })

const fs = await import("node:fs")
const path = await import("node:path")
const events = path.join(dir, ".opencode", ".rundev", "events.jsonl")
if (fs.existsSync(events)) {
  const lines = fs.readFileSync(events, "utf8").trim().split("\n").filter(Boolean)
  const last = JSON.parse(lines[lines.length - 1])
  console.log(`evento: ${last.type} · ${last.title ?? last.service ?? ""}`)
  console.log(last.text ?? last.message ?? "")
}
if (prompts.length) {
  console.log(`\n--- prompt enviado al agente (${prompts[0].length} chars) ---`)
  console.log(prompts[0].split("\n").slice(0, 12).join("\n"))
  console.log("…")
}
