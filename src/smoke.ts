/**
 * smoke.ts — `deno run -A src/smoke.ts`
 *
 * Exercises the engine end to end against a throwaway fixture: manifest,
 * validation, .env sections, process up/status/down, kill by pidfile, and the
 * terminal line guard. No keystrokes, no docker: safe to run any time.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { findManifest, validate } from "./manifest.ts"
import * as E from "./engine.ts"
import { buildLine, defaultStrategy } from "./terminal.ts"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundev-smoke-"))
let fails = 0

function ok(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "✔" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`)
  if (!cond) fails++
}

// ── fixture
fs.mkdirSync(path.join(root, ".opencode"), { recursive: true })
fs.writeFileSync(
  path.join(root, ".env"),
  ["DOMAIN=x", "# IOS", "# API_URL=http://localhost:4000/", "# ANDROID", "API_URL=http://10.0.2.2:4000/"].join("\n"),
)
fs.writeFileSync(
  path.join(root, ".opencode", "rundev.json"),
  JSON.stringify(
    {
      version: 1,
      default: ["sleeper", "interactive"],
      services: {
        sleeper: { kind: "process", up: "/bin/sleep 300", port: 45999 },
        interactive: {
          kind: "interactive",
          up: "echo hola",
          defaultTarget: "android",
          targets: {
            android: { envSection: "ANDROID" },
            ios: { envSection: "IOS" },
          },
        },
      },
    },
    null,
    2,
  ),
)

// ── manifest
const found = findManifest(path.join(root, ".opencode"))
ok("findManifest encuentra el manifiesto hacia arriba", !!found, found?.root)
if (!found) Deno.exit(1)
const loaded = found
const problems = validate(loaded)
ok("validate sin problemas", problems.length === 0, problems.join(" · "))

// ── .env sections
const env0 = E.envSections(root)
ok("detecta la sección activa (ANDROID)", env0?.active === "ANDROID", JSON.stringify(env0))
ok("aplica la sección IOS", E.applyEnvSection(root, "IOS").ok)
ok("tras aplicar, la activa es IOS", E.envSections(root)?.active === "IOS")
ok("vuelve a ANDROID", E.applyEnvSection(root, "ANDROID").ok && E.envSections(root)?.active === "ANDROID")

// ── interactive target + env guard
const plan = E.launchPlan(loaded, "interactive", loaded.manifest.services.interactive, "ios")
ok(
  "launchPlan(ios) avisa que el .env activo no coincide",
  typeof plan === "object" && "envWarning" in plan && Boolean((plan as E.LaunchPlan).envWarning),
  String((plan as any).envWarning ?? "").slice(0, 70),
)
const plan = E.launchPlan(loaded, "interactive", loaded.manifest.services.interactive, "android")
ok("launchPlan(android) no avisa", typeof plan === "object" && !(plan as any).envWarning)

// ── requires expansion (emulator before app)
const withReq = {
  ...loaded,
  manifest: {
    default: ["app"],
    services: {
      app: { kind: "interactive", up: "echo", defaultTarget: "android", targets: { android: { requires: ["emulator"] } } },
      emulator: { kind: "emulator", avd: "x" },
    },
  },
} as any
const order = E.expandRequires(withReq, ["app"])
ok("expandRequires pone el emulador antes de la app", JSON.stringify(order) === '["emulator","app"]', JSON.stringify(order))

// ── process lifecycle
const up1 = await E.up(loaded, ["sleeper"], { waitMs: 300 })
ok("up arranca el proceso", up1[0]?.action === "started", JSON.stringify(up1[0]))
const st1 = await E.statusOf(loaded, "sleeper")
ok("status lo ve arriba", st1.state === "running", `${st1.state} · ${st1.detail}`)
const pid = up1[0]?.pid ?? 0
ok("el pid está vivo", pid > 0 && E.alive(pid), `pid ${pid}`)
const pgid = (await E.run("/bin/ps", ["-o", "pgid=", "-p", String(pid)])).out.trim()
ok("es líder de su grupo (kill(-pid) funciona)", pgid === String(pid), `pid=${pid} pgid=${pgid}`)

const up2 = await E.up(loaded, ["sleeper"], { waitMs: 200 })
ok("up es idempotente (no duplica)", up2[0]?.action === "already", JSON.stringify(up2[0]))

const down1 = await E.down(loaded, ["sleeper"])
ok("down lo baja", down1[0]?.action === "stopped", JSON.stringify(down1[0]))
ok("ya no está vivo", !E.alive(pid))
const st2 = await E.statusOf(loaded, "sleeper")
ok("status lo ve abajo", st2.state === "stopped", `${st2.state} · ${st2.detail}`)

// ── terminal guard
const line = buildLine({ cwd: root, command: "flutter run", label: "app · ios" })
ok("buildLine empieza con el guard cd", Boolean(line?.startsWith(`cd '${root}' &&`)), line ?? "(null)")
ok("buildLine rechaza rutas con comillas", buildLine({ cwd: `${root}/a'b"c$d`, command: "x", label: "y" }) === null)
console.log(`   estrategia de terminal: ${defaultStrategy()}`)

console.log(`\n${fails === 0 ? "TODO OK ✔" : `${fails} FALLO(S) ✗`}`)
Deno.exit(fails === 0 ? 0 : 1)
