/**
 * harness.ts — dev-only. Loads the plugin with a mock context (no OpenCode
 * server) and runs one verb, so index.ts can be validated before the service
 * restart. Usage: node --experimental-strip-types dev/harness.ts <dir> "<verb>"
 */

import plugin from "../src/index.ts"

const dir = process.argv[2] ?? process.cwd()
const argv = (process.argv[3] ?? "status").split(/\s+/).filter(Boolean)

const commands: any[] = []
const tools: any[] = []
const namespaces: any[] = []

const mockCtx: any = {
  location: { directory: dir },
  session: { get: async () => ({ location: { directory: dir } }) },
  command: { transform: async (cb: any) => cb({ add: (d: any) => commands.push(d) }) },
  tool: {
    transform: async (cb: any) =>
      cb({ namespace: (n: any) => namespaces.push(n), add: (t: any) => tools.push(t) }),
  },
}

await (plugin as any).setup(mockCtx)

console.log("comando:", commands.map((c) => `${c.name} — ${c.description}`).join(", ") || "(ninguno)")
console.log("tools:", tools.map((t) => t.name).join(", ") || "(ninguno)")
console.log("namespace:", namespaces.map((n) => n.name).join(", ") || "(ninguno)")

const cmd = commands.find((c) => c.name === "rundev")
if (!cmd) {
  console.log("✗ the rundev command was not registered")
  process.exit(1)
} else {
  console.log(`\n--- rundev ${argv.join(" ")}`)
  await cmd.execute({ sessionID: "ses_mock", prompt: { text: argv.join(" ") }, delivery: "steer" })
  const fs = await import("node:fs")
  const path = await import("node:path")
  const file = path.join(dir, ".opencode", ".rundev", "events.jsonl")
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
  const last = JSON.parse(lines[lines.length - 1])
  console.log(`evento: ${last.type} · ${last.title ?? last.service ?? ""}`)
  console.log(last.text ?? last.message ?? "")
}
