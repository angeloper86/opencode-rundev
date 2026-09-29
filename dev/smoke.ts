/**
 * smoke.ts — `deno run -A dev/smoke.ts`
 *
 * Exercises the engine end to end against a throwaway fixture: manifest,
 * validation, .env sections, process up/status/down, kill by pidfile, and the
 * terminal line guard. No keystrokes, no docker: safe to run any time.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { findManifest, validate } from "../src/manifest.ts"
import * as E from "../src/engine.ts"
import { buildLine, defaultStrategy } from "../src/terminal.ts"

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
const planAndroid = E.launchPlan(loaded, "interactive", loaded.manifest.services.interactive, "android")
ok("launchPlan(android) no avisa", typeof planAndroid === "object" && !(planAndroid as any).envWarning)

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

// ── interactive: the panel marker is what makes a second `up` idempotent
let launches = 0
const launch = async (plan: E.LaunchPlan) => {
  launches++
  return { ok: true, detail: `panel ${launches} → ${plan.command}` }
}

const upP1 = await E.up(loaded, ["interactive"], { launch })
ok("interactive up opens the panel", upP1[0]?.action === "started", JSON.stringify(upP1[0]))
const marker = E.readPanel(root, "interactive")
ok("the launch marker is written with its target", marker?.target === "android", JSON.stringify(marker))
ok("the marker is not a pidfile (stopProcess must never kill by it)", E.readProc(root, "interactive") === null)
const stP = await E.statusOf(loaded, "interactive")
ok("status sees the panel as running", stP.state === "running", `${stP.state} · ${stP.detail}`)

const upP2 = await E.up(loaded, ["interactive"], { launch })
ok(
  "a second up does NOT open a second panel",
  upP2[0]?.action === "already" && launches === 1,
  `launches=${launches} · ${upP2[0]?.action}`,
)

const upP3 = await E.up(loaded, ["interactive"], { launch, force: true })
ok("--force relaunches exactly one panel", upP3[0]?.action === "started" && launches === 2, `launches=${launches}`)

const retarget = await E.up(loaded, ["interactive"], { targets: { interactive: "ios" }, launch })
ok(
  "an explicit target with an inactive .env section is blocked, not double-launched",
  retarget[0]?.action === "blocked" && launches === 2,
  JSON.stringify(retarget[0]),
)
ok("the blocked retarget keeps the marker on android", E.readPanel(root, "interactive")?.target === "android")

E.applyEnvSection(root, "IOS")
const upIos = await E.up(loaded, ["interactive"], { targets: { interactive: "ios" }, launch })
ok("up app@ios relaunches for the new target", upIos[0]?.action === "started" && launches === 3, JSON.stringify(upIos[0]))
ok("the marker records the new target", E.readPanel(root, "interactive")?.target === "ios")
E.applyEnvSection(root, "ANDROID")

const downP = await E.down(loaded, ["interactive"])
ok(
  "down forgets the panel",
  downP[0]?.action === "stopped" && E.readPanel(root, "interactive") === null,
  JSON.stringify(downP[0]),
)
ok("stopProcess never sees the panel marker", (await E.stopProcess(root, "interactive")).detail.includes("nothing to stop"))

const upP4 = await E.up(loaded, ["interactive"], { launch })
ok("after down, up opens a panel again", upP4[0]?.action === "started" && launches === 4, `launches=${launches}`)

// ── interactive + `check`: a declared check makes the panel verifiable
const withCheck = (check: string) =>
  ({ ...loaded, manifest: { services: { app: { kind: "interactive", up: "echo", check } } } }) as any
const stBad = await E.statusOf(withCheck("test -f /rundev-does-not-exist"), "app")
ok("a failing check reports the panel as gone (up would relaunch)", stBad.state === "stopped", `${stBad.state} · ${stBad.detail}`)
const stOk = await E.statusOf(withCheck("true"), "app")
ok(
  "a passing check reports the panel as running, even with no marker",
  stOk.state === "running" && stOk.detail.includes("check passes"),
  `${stOk.state} · ${stOk.detail}`,
)

// per-target check: each device is verified on its own terms
const perTarget = {
  ...loaded,
  manifest: {
    services: {
      app: {
        kind: "interactive",
        up: "echo",
        defaultTarget: "android",
        targets: { android: { check: "true" }, ios: { check: "test -f /rundev-does-not-exist" } },
      },
    },
  },
} as any
ok("per-target check: the default target passes → running", (await E.statusOf(perTarget, "app")).state === "running")
E.writePanel(root, "app", { label: "x", command: "echo", cwd: root, target: "ios", startedAt: Date.now() })
ok(
  "per-target check follows the recorded target, not the default",
  (await E.statusOf(perTarget, "app")).state === "stopped",
)
E.clearPanel(root, "app")

// ── terminal guard
const line = buildLine({ cwd: root, command: "flutter run", label: "app · ios" })
ok("buildLine empieza con el guard cd", Boolean(line?.startsWith(`cd '${root}' &&`)), line ?? "(null)")
ok("buildLine rechaza rutas con comillas", buildLine({ cwd: `${root}/a'b"c$d`, command: "x", label: "y" }) === null)
console.log(`   estrategia de terminal: ${defaultStrategy()}`)

// ── uninstall helpers
fs.writeFileSync(
  path.join(root, ".gitignore"),
  "node_modules/\n.opencode/.rundev/\n.opencode/.chrome-profile/\ndist/\n",
)
ok(
  "gitignoreEntriesPresent detects rundev's entries",
  E.gitignoreEntriesPresent(root).length === 2,
  JSON.stringify(E.gitignoreEntriesPresent(root)),
)
const dryRows = E.cleanRepo(loaded, { dryRun: true })
ok(
  "cleanRepo (dry run) reports without touching anything",
  dryRows.some((r) => r.action === "would-remove") && fs.existsSync(path.join(root, ".gitignore")),
)
const cleanRows = E.cleanRepo(loaded, { dryRun: false })
ok(
  "cleanRepo removes the state dir but keeps the manifest",
  !fs.existsSync(path.join(root, ".opencode", ".rundev")) && fs.existsSync(path.join(root, ".opencode", "rundev.json")),
  JSON.stringify(cleanRows.map((r) => r.what)),
)
const gi = fs.readFileSync(path.join(root, ".gitignore"), "utf8")
ok(
  ".gitignore keeps the user's lines only",
  !gi.includes(".opencode") && gi.includes("node_modules/") && gi.includes("dist/"),
  JSON.stringify(gi),
)

console.log(`\n${fails === 0 ? "TODO OK ✔" : `${fails} FALLO(S) ✗`}`)
Deno.exit(fails === 0 ? 0 : 1)
