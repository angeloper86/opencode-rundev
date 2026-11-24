/**
 * plugin.test.ts — `node --experimental-strip-types dev/plugin.test.ts`
 *
 * The layer above the engine: what an agent's tool call and a person's `/rundev`
 * actually do inside a repo, a workspace root and a workspace member. The plugin
 * is loaded with a mock context (no OpenCode server, no model), against throwaway
 * fixtures. Nothing here starts a real service, a panel, a device or a browser.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import plugin from "../src/index.ts"
import { listClients, registerClient } from "../src/clients.ts"
import { pickHostTerminal } from "../src/ghostty.ts"
import { findManifest } from "../src/manifest.ts"
import { buildLine, parseStrategy } from "../src/terminal.ts"

process.env.RUNDEV_NO_TIMELINE = "1" // never mirror a test report into a real session
const clientsDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundev-clients-"))
process.env.RUNDEV_CLIENTS_DIR = clientsDir

let fails = 0
let count = 0
async function test(name: string, fn: () => Promise<void> | void) {
  count++
  try {
    await fn()
    console.log(`✔ ${name}`)
  } catch (err) {
    fails++
    console.log(`✗ ${name}\n    ${String((err as Error).message).split("\n").join("\n    ")}`)
  }
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), "rundev-plugin-"))
const write = (file: string, content: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2))
}

// ── fixtures ────────────────────────────────────────────────────────────────
// A workspace of two repos: an api and a flutter app that depends on it.
const acme = path.join(base, "acme")
write(path.join(acme, "rundev.workspace.json"), { name: "acme", members: ["acme-api", "acme-app"], dependencies: { "acme-app": ["acme-api"] } })
write(path.join(acme, "acme-api/.opencode/rundev.json"), {
  version: 1,
  default: ["api"],
  services: { api: { kind: "process", up: "sleep 300", port: 45951, health: "http://127.0.0.1:45951/health" } },
})
write(path.join(acme, "acme-app/.opencode/rundev.json"), {
  version: 1,
  default: ["app"],
  services: {
    emulator: { kind: "emulator", avd: "pixel_8_api_36" },
    app: { kind: "interactive", up: "flutter run", defaultTarget: "android", targets: { android: { requires: ["emulator"] } } },
  },
})
// The same, with members written as paths (a monorepo layout).
const mono = path.join(base, "mono")
write(path.join(mono, "rundev.workspace.json"), { name: "mono", members: ["apps/api", "apps/app"], dependencies: { "apps/app": ["apps/api"] } })
write(path.join(mono, "apps/api/.opencode/rundev.json"), { services: { api: { kind: "process", up: "sleep 301", port: 45952 } } })
write(path.join(mono, "apps/app/.opencode/rundev.json"), { services: { app: { kind: "process", up: "sleep 302" } } })

interface Loaded {
  call: (name: string, input: any, sessionID?: string) => Promise<string>
  run: (text: string, sessionID?: string) => Promise<string>
  tools: any[]
  namespace: () => string
}

/** Loads the plugin as the server would, with `sessions` mapping a session id to its directory. */
async function load(defaultDir: string, sessions: Record<string, string> = {}): Promise<Loaded> {
  const commands: any[] = []
  const tools: any[] = []
  let namespace = ""
  const ctx: any = {
    location: { directory: defaultDir },
    session: {
      get: async ({ sessionID }: any) => ({ location: { directory: sessions[sessionID] ?? defaultDir } }),
      prompt: async () => ({}),
    },
    command: { transform: async (cb: any) => cb({ add: (d: any) => commands.push(d) }) },
    tool: {
      transform: async (cb: any) => cb({ namespace: (n: any) => (namespace = n.description), add: (t: any) => tools.push(t) }),
      reload: async () => {},
    },
    skill: { transform: async (cb: any) => cb({ add() {} }) },
  }
  await (plugin as any).setup(ctx)
  const command = commands.find((c) => c.name === "rundev")
  return {
    tools,
    namespace: () => namespace,
    call: async (name, input, sessionID) => String((await tools.find((t) => t.name === name).execute(input, { sessionID })).content),
    run: async (text, sessionID) => {
      await command.execute({ sessionID, prompt: { text } })
      const dir = sessionID ? (sessions[sessionID] ?? defaultDir) : defaultDir
      const root = findManifest(dir)?.root ?? dir
      const events = path.join(root, ".opencode", ".rundev", "events.jsonl")
      const lines = fs.readFileSync(events, "utf8").trim().split("\n").map((l) => JSON.parse(l))
      return String([...lines].reverse().find((l: any) => l.type === "report")?.text ?? "")
    },
  }
}
const selects = (dir: string) => {
  try {
    return fs
      .readFileSync(path.join(dir, ".opencode", ".rundev", "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === "select")
  } catch {
    return []
  }
}

// ═════════════════════════════════════════════════════════ from inside a member
await test("from a member, `api` + `app@android` is the user's own sentence: no 'not in the manifest'", async () => {
  const p = await load(path.join(acme, "acme-app"))
  const out = await p.call("up", { services: ["api", "app@android"], dryRun: true })
  assert.ok(!/not in the manifest/.test(out), out)
  assert.match(out, /acme-api/)
  assert.match(out, /acme-app/)
  assert.ok(out.indexOf("acme-api") < out.indexOf("acme-app"), "the api comes before the app")
  assert.ok(out.indexOf("emulator") < out.indexOf("app  "), "the emulator comes before the app")
})

await test("from a member, `acme-api:api` and a bare `app@android` both work", async () => {
  const p = await load(path.join(acme, "acme-app"))
  assert.ok(!/ERR/.test(await p.call("up", { services: ["acme-api:api"], dryRun: true })))
  const out = await p.call("up", { services: ["app@android"], dryRun: true })
  assert.match(out, /acme-api \(dependency\)/, "naming only the app still brings its dependency up first")
})

await test("from a member, status shows the dependency too", async () => {
  const out = await (await load(path.join(acme, "acme-app"))).call("status", {})
  assert.match(out, /acme-app/)
  assert.match(out, /acme-api \(dependency\)/)
})

await test("`--all` from a member reaches the whole workspace", async () => {
  const out = await (await load(path.join(acme, "acme-app"))).run("status --all")
  assert.match(out, /acme-api/)
  assert.match(out, /acme-app/)
})

await test("logs / env / doctor of ANOTHER member work from a member", async () => {
  const p = await load(path.join(acme, "acme-app"))
  assert.match(await p.call("logs", { service: "acme-api:api" }), /acme-api:api/)
  assert.match(await p.run("doctor --all"), /rundev doctor · workspace acme/)
})

await test("a typo says what exists, instead of failing silently", async () => {
  const out = await (await load(path.join(acme, "acme-app"))).call("up", { services: ["nope"], dryRun: true })
  assert.match(out, /neither a member nor a service/)
  assert.match(out, /acme-api: api/)
})

await test("members written as paths keep their dependencies (the key is the path, not the basename)", async () => {
  const out = await (await load(path.join(mono, "apps/app"))).call("up", { services: ["app"], dryRun: true })
  assert.match(out, /apps\/api \(dependency\)/, out)
})

// ═════════════════════════════════════════════════════════ the workspace root
await test("an agent tool at the workspace root never opens a picker in the TUI", async () => {
  const p = await load(acme, { s: acme })
  const status = await p.call("status", {}, "s")
  assert.match(status, /acme-api/)
  assert.match(status, /acme-app/, "status at the root shows every member")
  const up = await p.call("up", {}, "s")
  assert.match(up, /up what\?/)
  await p.call("down", {}, "s")
  assert.equal(selects(acme).length, 0, "tools must not emit `select`")
})

await test("a person's `/rundev up` at the root does get the picker", async () => {
  const p = await load(acme, { s: acme })
  await p.run("up", "s")
  const sel = selects(acme)
  assert.equal(sel.length, 1)
  assert.equal(sel[0].verb, "up")
  assert.equal(sel[0].sessionID, "s")
})

await test("at the root: member:service@target, dependencies first, bare service names resolve", async () => {
  const p = await load(acme)
  const out = await p.call("up", { services: ["acme-app:app@android"], dryRun: true })
  assert.match(out, /acme-api \(dependency\)/)
  assert.ok(out.indexOf("acme-api") < out.indexOf("acme-app"))
  assert.match(await p.call("up", { services: ["app@android"], dryRun: true }), /acme-app/)
})

await test("at the root: logs, env and doctor are not 'no manifest here'", async () => {
  const p = await load(acme)
  assert.ok(!/no manifest here/.test(await p.call("logs", { service: "acme-api:api" })))
  assert.ok(!/no manifest here/.test(await p.call("env", {})))
  const doctor = await p.call("doctor", {})
  assert.match(doctor, /workspace problems: none/)
  assert.match(doctor, /rundev doctor · acme-api/)
  assert.match(doctor, /rundev doctor · acme-app/)
})

await test("a target that does not exist is named, with what does", async () => {
  const out = await (await load(acme)).call("up", { services: ["acme-app:app@ios"], dryRun: true })
  assert.match(out, /target "ios" does not exist/)
  assert.match(out, /declared: android/)
})

// ═══════════════════════════════════════════════════════════ editing manifests
await test("a patch never overwrites a manifest that is not valid JSON", async () => {
  const dir = path.join(base, "corrupt")
  const broken = '<<<<<<< HEAD\n{ "services": { "db": { "kind": "process", "up": "a" } } }\n=======\n>>>>>>> x\n'
  write(path.join(dir, ".opencode/rundev.json"), broken)
  const out = await (await load(dir)).call("apply", { patch: { services: { w: { kind: "process", up: "x" } } } })
  assert.match(out, /not written/)
  assert.match(out, /not valid JSON/)
  assert.equal(fs.readFileSync(path.join(dir, ".opencode/rundev.json"), "utf8"), broken, "the file is untouched")
})

await test("a broken manifest is reported as invalid JSON, not as 'no services'", async () => {
  const dir = path.join(base, "corrupt2")
  write(path.join(dir, ".opencode/rundev.json"), "{ nope")
  assert.match(await (await load(dir)).call("status", {}), /invalid JSON/)
})

await test("fields rundev does not know are refused, with the right name", async () => {
  const dir = path.join(base, "typos")
  const original = { version: 1, services: { db: { kind: "process", up: "a" } } }
  write(path.join(dir, ".opencode/rundev.json"), original)
  const out = await (await load(dir)).call("apply", {
    patch: { services: { api: { kind: "process", up: "b", dependsOn: ["db"], healt: "http://x" } } },
  })
  assert.match(out, /not written/)
  assert.match(out, /healt.*did you mean "health"/)
  assert.match(out, /dependsOn/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, ".opencode/rundev.json"), "utf8")), original)
})

await test("`requires` is a real field: a patch with it is written, an unknown dependency is not", async () => {
  const dir = path.join(base, "requires")
  write(path.join(dir, ".opencode/rundev.json"), { version: 1, services: { db: { kind: "process", up: "a" }, api: { kind: "process", up: "b" } } })
  const p = await load(dir)
  assert.match(await p.call("apply", { patch: { services: { api: { requires: ["nope"] } } } }), /requires "nope" which does not exist/)
  assert.match(await p.call("apply", { patch: { services: { api: { requires: ["db"] } } } }), /changed: api/)
})

await test("apply stays inside the session: a `root` elsewhere is refused", async () => {
  const dir = path.join(base, "inside")
  write(path.join(dir, ".opencode/rundev.json"), { version: 1, services: { a: { kind: "process", up: "x" } } })
  const elsewhere = path.join(base, "elsewhere")
  fs.mkdirSync(elsewhere, { recursive: true })
  const out = await (await load(dir)).call("apply", { root: elsewhere, patch: { services: { b: { kind: "process", up: "y" } } } })
  assert.match(out, /outside this session/)
  assert.ok(!fs.existsSync(path.join(elsewhere, ".opencode")))
})

await test("apply from a subfolder edits the repo's manifest, not a new one beside it", async () => {
  const repo = path.join(base, "monorepo")
  write(path.join(repo, ".opencode/rundev.json"), { version: 1, services: { api: { kind: "process", up: "pnpm dev", port: 45960 } } })
  fs.mkdirSync(path.join(repo, "apps/web"), { recursive: true })
  const out = await (await load(path.join(repo, "apps/web"))).call("apply", { patch: { services: { web: { kind: "process", up: "pnpm web", port: 45961 } } } })
  assert.match(out, /added: web/)
  assert.ok(!fs.existsSync(path.join(repo, "apps/web/.opencode/rundev.json")), "no second manifest")
  assert.ok(JSON.parse(fs.readFileSync(path.join(repo, ".opencode/rundev.json"), "utf8")).services.web)
})

await test("`/rundev init` from a subfolder of an initialised repo does not shadow its manifest", async () => {
  const repo = path.join(base, "monorepo2")
  write(path.join(repo, ".opencode/rundev.json"), { version: 1, services: { api: { kind: "process", up: "pnpm dev", port: 45962 } } })
  fs.mkdirSync(path.join(repo, "apps/web"), { recursive: true })
  const p = await load(path.join(repo, "apps/web"))
  const out = await p.run("init")
  assert.match(out, /already exists/)
  assert.ok(!fs.existsSync(path.join(repo, "apps/web/.opencode/rundev.json")))
  assert.match(await p.call("status", {}), /api/)
})

await test("`default` entries with a target: a bare `up` honours them", async () => {
  const dir = path.join(base, "deftarget")
  write(path.join(dir, ".opencode/rundev.json"), {
    version: 1,
    default: ["app@ios"],
    services: { app: { kind: "interactive", up: "flutter run", targets: { android: {}, ios: {} } } },
  })
  const out = await (await load(dir)).call("up", { dryRun: true })
  assert.match(out, /would open a panel \[ios\]/, out)
})

// ═══════════════════════════════════════════════════ .env is a person's decision
const dotenvBoth = "API=1\n# ANDROID\nAPI_URL=http://10.0.2.2\n# IOS\n# API_URL=http://localhost\n"
const envRepo = (name: string) => {
  const dir = path.join(base, name)
  write(path.join(dir, ".env"), dotenvBoth)
  write(path.join(dir, ".opencode/rundev.json"), {
    version: 1,
    services: { app: { kind: "interactive", up: "flutter run", defaultTarget: "android", targets: { android: { envSection: "ANDROID" }, ios: { envSection: "IOS" } } } },
  })
  return dir
}

await test("asking for ios while .env says ANDROID: without switchEnv it stops and says how to go on", async () => {
  process.env.RUNDEV_STRATEGY = "print" // never open a panel or touch the clipboard from a test
  const dir = envRepo("envrepo1")
  const p = await load(dir)
  const blocked = await p.call("up", { services: ["app@ios"] })
  assert.match(blocked, /blocked/)
  assert.match(blocked, /\/rundev env IOS.*switchEnv/)
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), dotenvBoth, ".env untouched")
})

await test("…and with switchEnv the agent's single call switches it, launches, and reports the change", async () => {
  const dir = envRepo("envrepo2")
  const p = await load(dir)
  const out = await p.call("up", { services: ["app@ios"], switchEnv: true })
  assert.ok(!/blocked/.test(out), out)
  assert.match(out, /flutter run/, "it went on to the launch")
  assert.match(await p.call("env", {}), /active: IOS/)
  assert.match(fs.readFileSync(path.join(dir, ".env"), "utf8"), /^# API_URL=http:\/\/10\.0\.2\.2/m, "the ANDROID block was commented out")
  const events = fs.readFileSync(path.join(dir, ".opencode/.rundev/events.jsonl"), "utf8")
  assert.match(events, /switched \.env ANDROID → IOS/, "the switch is on the record")
})

await test("the `env` tool switches only when asked to, and says what it was", async () => {
  const dir = envRepo("envrepo3")
  const p = await load(dir)
  assert.match(await p.call("env", { section: "IOS" }), /active: ANDROID/, "a section without `switch` only reads")
  assert.match(await p.call("env", { section: "IOS", switch: true }), /IOS enabled .*was ANDROID/)
  assert.match(await p.call("env", {}), /active: IOS/)
})

await test("a flag smuggled into the arguments is not a parameter: it is dropped", async () => {
  const dir = envRepo("envrepo4")
  const p = await load(dir)
  const out = await p.call("up", { services: ["--switch-env", "--force", "app@ios"] })
  assert.match(out, /blocked/, out)
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), dotenvBoth)
})

await test("a person's `/rundev env IOS` still works the same way", async () => {
  const dir = envRepo("envrepo5")
  const p = await load(dir)
  assert.match(await p.run("env IOS"), /IOS enabled .*was ANDROID/)
})

// ═══════════════════════════════ repos that wait for each other do not wait to boot devices
await test("a member that waits for its dependency boots its emulator meanwhile, and nothing is reported twice", async () => {
  const bin = path.join(base, "fakebin")
  const flag = path.join(base, "emulator-up.flag")
  write(path.join(bin, "flutter"), `#!/bin/sh\ntouch "${flag}"\n`)
  write(
    path.join(bin, "adb"),
    `#!/bin/sh
case "$*" in
  "devices") if [ -f "${flag}" ]; then printf 'List of devices attached\\nemulator-5600\\tdevice\\n'; else printf 'List of devices attached\\n'; fi ;;
  "-s emulator-5600 emu avd name") printf 'par_avd\\nOK\\n' ;;
  *"getprop sys.boot_completed") printf '1\\n' ;;
  *"emu kill") rm -f "${flag}" ;;
esac
exit 0
`,
  )
  fs.chmodSync(path.join(bin, "flutter"), 0o755)
  fs.chmodSync(path.join(bin, "adb"), 0o755)
  const oldPath = process.env.PATH
  process.env.PATH = `${bin}:${oldPath}`
  process.env.RUNDEV_FLUTTER = path.join(bin, "flutter")

  const ws = path.join(base, "par")
  write(path.join(ws, "rundev.workspace.json"), { name: "par", members: ["p-api", "p-app"], dependencies: { "p-app": ["p-api"] } })
  write(path.join(ws, "p-api/.opencode/rundev.json"), {
    version: 1,
    services: {
      api: {
        kind: "process",
        // absolute node: a login shell resets PATH on Debian/Ubuntu
        up: `"${process.execPath}" -e "setTimeout(()=>require('http').createServer((q,r)=>r.end('ok')).listen(45971,'127.0.0.1'),3200)"`,
        port: 45971,
        health: "http://127.0.0.1:45971/",
      },
    },
  })
  write(path.join(ws, "p-app/.opencode/rundev.json"), {
    version: 1,
    services: {
      emulator: { kind: "emulator", avd: "par_avd" },
      app: { kind: "process", up: "sleep 66.5", requires: ["emulator"] },
    },
  })
  try {
    const p = await load(ws)
    const out = await p.call("up", { services: ["p-app:app"], wait: 9000 })
    assert.equal(out.split("\n").filter((l) => /^\s+\S+\s+emulator\s/.test(l)).length, 1, `one emulator line:\n${out}`)
    assert.match(out, /ok\s+emulator\s+started/, out)
    assert.match(out, /ok\s+app\s+started/, out)
    assert.ok(out.indexOf("p-api") < out.indexOf("p-app"), "the api's section comes first")
    // parallel, structurally: the emulator launch happens BEFORE the api answers its health check
    const events = (repo: string) =>
      fs.readFileSync(path.join(ws, repo, ".opencode/.rundev/events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    const launched = events("p-app").find((e) => /launching AVD/.test(e.message ?? ""))?.ts
    const apiReady = events("p-api").find((e) => e.service === "api" && /ready$/.test(e.message ?? ""))?.ts
    assert.ok(launched && apiReady && launched < apiReady, `emulator launched at ${launched}, api ready at ${apiReady}`)
  } finally {
    await (await load(ws)).call("down", { all: true })
    process.env.PATH = oldPath
    delete process.env.RUNDEV_FLUTTER
  }
})

// ═════════════════════════════════════════ what the model is told about the place
await test("the namespace tells the agent where it is: workspace root", async () => {
  const text = (await load(acme)).namespace()
  assert.match(text, /workspace acme/)
  assert.match(text, /acme-app\[emulator\(emulator\), app\(interactive targets\[android\]\)\]/)
  assert.match(text, /acme-app → acme-api/)
  assert.match(text, /tools\.rundev\.up\(/)
})

await test("…and inside a member: its workspace, its dependency, its siblings", async () => {
  const text = (await load(path.join(acme, "acme-app"))).namespace()
  assert.match(text, /member of workspace acme/)
  assert.match(text, /up brings acme-api up first/)
  assert.match(text, /acme-api\[api\]/)
})

await test("up and status are pinned; apply goes through the permission system", async () => {
  const p = await load(path.join(acme, "acme-app"))
  const opt = (name: string) => p.tools.find((t) => t.name === name).options
  assert.equal(opt("up").pinned, true)
  assert.equal(opt("status").pinned, true)
  assert.equal(opt("apply").permission, "rundev_apply")
  assert.equal(opt("up").codemode, true)
})

// ══════════════════════════════════════════ the panel goes to the right terminal
await test("the terminal of a session is the one its TUI registered — not whichever has the focus", async () => {
  registerClient({ pid: process.pid, tty: "/dev/ttys042", dir: "/x", sessionID: "ses_mine" })
  assert.ok(listClients().some((c) => c.sessionID === "ses_mine"))
  const terminals = [
    { id: "T-1", tty: "/dev/ttys001", pid: process.pid, cwd: "/x" },
    { id: "T-2", tty: "/dev/ttys042", pid: process.pid, cwd: "/elsewhere" },
  ]
  const pick = await pickHostTerminal({ sessionID: "ses_mine", dir: "/x", terminals })
  assert.equal(pick.terminal?.id, "T-2", pick.reason)
})

await test("no registered terminal and nobody running opencode here: nothing is chosen, and it says why", async () => {
  const pick = await pickHostTerminal({ sessionID: "ses_unknown", dir: "/x", terminals: [{ id: "T-1", tty: "/dev/ttys001", pid: process.pid, cwd: "/x" }] })
  assert.equal(pick.terminal, undefined)
  assert.match(pick.reason, /no Ghostty terminal is running OpenCode/)
})

await test("old strategy names keep working, and the line keeps its cd guard", () => {
  assert.equal(parseStrategy("ghostty-split"), "ghostty-api")
  assert.equal(parseStrategy("clipboard"), "clipboard")
  assert.equal(parseStrategy("nope"), undefined)
  assert.match(buildLine({ cwd: "/repo", command: "flutter run", label: "app · ios" }) ?? "", /^cd '\/repo' && echo/)
  assert.equal(buildLine({ cwd: `/re'po"$x`, command: "x", label: "y" }), null)
  assert.match(buildLine({ cwd: `/re'po"$x`, command: "x", label: "y" }, false) ?? "", /^echo '\[rundev\] y' && x$/)
})

fs.rmSync(clientsDir, { recursive: true, force: true })
console.log(`\n${fails === 0 ? `TODO OK ✔ (${count} tests)` : `${fails} of ${count} FAILED ✗`}`)
process.exit(fails === 0 ? 0 : 1)
