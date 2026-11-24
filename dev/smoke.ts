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
import {
  defaultPlan,
  findManifest,
  findWorkspace,
  lintManifest,
  memberOf,
  mergeLocal,
  patchManifest,
  readJsonStrict,
  validate,
  validateWorkspace,
  workspaceMembers,
} from "../src/manifest.ts"
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

// ── machine overrides are a PATCH: a target's device must not drop its check/requires
fs.writeFileSync(
  path.join(root, ".opencode", "rundev.local.json"),
  JSON.stringify({ services: { interactive: { targets: { ios: { device: "iPhone 17" } } } } }),
)
const merged = findManifest(root)
ok(
  "el .local.json parchea el target sin borrar envSection",
  merged?.manifest.services.interactive?.targets?.ios?.envSection === "IOS" &&
    merged?.manifest.services.interactive?.targets?.ios?.device === "iPhone 17",
  JSON.stringify(merged?.manifest.services.interactive?.targets),
)
ok(
  "el .local.json no toca el otro target",
  merged?.manifest.services.interactive?.targets?.android?.envSection === "ANDROID",
)
fs.rmSync(path.join(root, ".opencode", "rundev.local.json"), { force: true })

// ── mergeLocal is what `apply` validates before writing anything
const preview = mergeLocal(
  {
    version: 1,
    services: {
      app: { kind: "interactive", up: "flutter run", targets: { ios: { requires: ["simulator"], envSection: "IOS" } } },
    },
  },
  { services: { app: { targets: { ios: { device: "X" } } } } },
)
ok(
  "mergeLocal conserva requires/envSection al parchear device",
  preview.services.app.targets?.ios?.requires?.[0] === "simulator" &&
    preview.services.app.targets?.ios?.envSection === "IOS" &&
    preview.services.app.targets?.ios?.device === "X",
  JSON.stringify(preview.services.app.targets),
)
ok(
  "apply rechazaría un requires inexistente en ese mismo merge",
  validate({ root, file: "", manifest: preview, localApplied: false }).some((p) => p.includes("simulator")),
)

// ── patchManifest: "add the ios target" touches only what it names
const committedManifest = {
  version: 1,
  default: ["app", "db"],
  services: {
    app: {
      kind: "interactive" as const,
      up: "flutter run",
      defaultTarget: "android",
      targets: { android: { requires: ["emulator"], check: "true" } },
    },
    db: { kind: "process" as const, up: "x", port: 5433 },
    emulator: { kind: "emulator" as const, avd: "a" },
  },
}
const patched = patchManifest(committedManifest, {
  services: { app: { targets: { ios: { requires: ["simulator"] } } } },
})
ok(
  "el patch agrega el target y conserva el otro entero",
  patched.manifest.services.app?.targets?.android?.check === "true" &&
    patched.manifest.services.app?.targets?.ios?.requires?.[0] === "simulator",
  JSON.stringify(patched.manifest.services.app?.targets),
)
ok(
  "el patch no reescribe lo que no nombró",
  (patched.manifest.default ?? []).join() === "app,db" && patched.manifest.services.db?.port === 5433,
)
ok("el patch reporta qué cambió", patched.changed.join() === "app" && patched.added.length === 0, JSON.stringify(patched))
const dropped = patchManifest(committedManifest, {}, ["db"])
ok(
  "remove borra el servicio y lo saca de default",
  !dropped.manifest.services.db && (dropped.manifest.default ?? []).join() === "app" && dropped.removed.join() === "db",
  JSON.stringify(dropped.manifest.default),
)
ok(
  "remove de algo inexistente se reporta, no falla",
  patchManifest(committedManifest, {}, ["nope"]).missing.join() === "nope",
)
ok(
  "un patch que solo cambia default se reporta como default",
  patchManifest(committedManifest, { default: ["db"] }).defaultChanged,
)

// ── every target is validated, not only the default one
const badTargets = {
  ...loaded,
  manifest: {
    services: {
      app: { kind: "interactive", up: "echo", defaultTarget: "android", targets: { android: {}, ios: { requires: ["nope"] } } },
    },
  },
} as any
const badProblems = validate(badTargets)
ok(
  "validate revisa los requires de TODOS los targets",
  badProblems.some((p) => p.includes("app@ios") && p.includes("nope")),
  badProblems.join(" · "),
)
ok(
  "validate detecta un defaultTarget inexistente",
  validate({
    ...loaded,
    manifest: { services: { app: { kind: "interactive", up: "echo", defaultTarget: "web", targets: { ios: {} } } } },
  } as any).some((p) => p.includes("defaultTarget")),
)

// ── device resolution for `flutter run`
ok("flutterDeviceFlag agrega -d cuando la app no lo decidió", E.flutterDeviceFlag("flutter run", "abc") === "flutter run -d abc")
ok("flutterDeviceFlag respeta un -d explícito", E.flutterDeviceFlag("flutter run -d X", "abc") === "flutter run -d X")
ok("flutterDeviceFlag no toca otros comandos", E.flutterDeviceFlag("yarn dev", "abc") === "yarn dev")
const pinned = {
  ...loaded,
  manifest: {
    services: {
      app: { kind: "interactive", up: "flutter run", targets: { ios: { device: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" } } },
    },
  },
} as any
const pinnedPlan = await E.launchPlan(pinned, "app", pinned.manifest.services.app, "ios")
ok(
  "launchPlan resuelve el device y lo pasa como -d",
  "command" in pinnedPlan && pinnedPlan.command === "flutter run -d AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  "command" in pinnedPlan ? pinnedPlan.command : pinnedPlan.error,
)

// ── .env sections
const env0 = E.envSections(root)
ok("detecta la sección activa (ANDROID)", env0?.active === "ANDROID", JSON.stringify(env0))
ok("aplica la sección IOS", E.applyEnvSection(root, "IOS").ok)
ok("tras aplicar, la activa es IOS", E.envSections(root)?.active === "IOS")
ok("vuelve a ANDROID", E.applyEnvSection(root, "ANDROID").ok && E.envSections(root)?.active === "ANDROID")

// ── interactive target + env guard
const plan = await E.launchPlan(loaded, "interactive", loaded.manifest.services.interactive, "ios")
ok(
  "launchPlan(ios) avisa que el .env activo no coincide",
  typeof plan === "object" && "envWarning" in plan && Boolean((plan as E.LaunchPlan).envWarning),
  String((plan as any).envWarning ?? "").slice(0, 70),
)
const planAndroid = await E.launchPlan(loaded, "interactive", loaded.manifest.services.interactive, "android")
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

// ── port preflight: a port that is already taken blocks the start
// (it needs `lsof`: macOS ships it, a bare Linux image may not)
const hasLsof = ["/usr/sbin/lsof", "/usr/bin/lsof"].some((p) => fs.existsSync(p))
if (hasLsof) {
  const guardPort = 45998
  const listener = Deno.listen({ port: guardPort })
  const guardLoaded = {
    root,
    file: path.join(root, ".opencode", "rundev.json"),
    manifest: { services: { guard: { kind: "process", up: "/bin/sleep 300", port: guardPort } } },
    localApplied: false,
  } as any
  const guardUp = await E.up(guardLoaded, ["guard"], { waitMs: 300 })
  ok(
    "up bloquea cuando el puerto ya está ocupado",
    guardUp[0]?.action === "blocked" && /in use/.test(guardUp[0]?.detail ?? ""),
    JSON.stringify(guardUp[0]),
  )
  ok("no arranca nada cuando el puerto está tomado", E.readProc(root, "guard") === null)
  listener.close()
} else {
  console.log("-  port preflight tests skipped: no lsof on this machine")
}
ok(
  "listenPort deriva el puerto del health cuando no hay `port`",
  E.listenPort({ kind: "process", up: "x", health: "http://127.0.0.1:45996/health" } as any) === 45996,
)

// ── the simulator UI: Xcode 27 replaced Simulator.app with DeviceHub
const uiCandidates = E.simulatorUiCandidates("/Applications/Xcode.app/Contents/Developer")
ok(
  "la UI del simulador prefiere DeviceHub (dentro del bundle de Xcode)",
  uiCandidates[0] === "/Applications/Xcode.app/Contents/Applications/DeviceHub.app",
  uiCandidates[0],
)
ok(
  "mantiene Simulator.app como fallback de Xcode viejo",
  uiCandidates.some((p) => p.endsWith("/Applications/Simulator.app")),
  uiCandidates.join(" · "),
)
const ui = await E.simulatorUiApp()
ok("simulatorUiApp resuelve una UI o degrada a LaunchServices", Boolean(ui.name && ui.bundleID), `${ui.name} ${ui.path ?? "(no path)"}`)

// ── dry run: the plan, without side effects
const planned = await E.up(loaded, ["sleeper"], { dryRun: true })
ok(
  "dry run reporta el plan sin arrancar nada",
  planned[0]?.action === "planned" && E.readProc(root, "sleeper") === null,
  JSON.stringify(planned[0]),
)
ok(
  "allSet es todo lo declarado (lo que para un `down` sin argumentos)",
  JSON.stringify(E.allSet(loaded).sort()) === JSON.stringify(Object.keys(loaded.manifest.services).sort()),
)

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

// ── compose: the row is matched by service, never by a look-alike name
const composeRows = [
  { Name: "laifapp_mysql", Service: "mysql", State: "running", Status: "Up 5 minutes" },
  { Name: "laifapp_php", Service: "app", State: "exited", Status: "Exited (0) 16 hours ago" },
]
ok(
  "matchComposeRow no confunde laifapp_mysql con el servicio app",
  E.matchComposeRow(composeRows, "app")?.Service === "app",
  JSON.stringify(E.matchComposeRow(composeRows, "app")),
)
ok(
  "matchComposeRow cae al nombre exacto cuando no hay Service",
  E.matchComposeRow([{ Name: "x-app" }], "x-app")?.Name === "x-app",
)
ok(
  "matchComposeRow no matchea por substring",
  E.matchComposeRow([{ Name: "laifapp_mysql" }], "app") === undefined,
)

// ── verifyInteractive: bounded wait for the declared check
ok("verifyInteractive: check que pasa → true", (await E.verifyInteractive(withCheck("true"), "app", undefined, 1500)) === true)
ok(
  "verifyInteractive: check que falla → false",
  (await E.verifyInteractive(withCheck("test -f /rundev-does-not-exist"), "app", undefined, 1000)) === false,
)
ok("verifyInteractive: sin check declarado → null", (await E.verifyInteractive(loaded, "interactive", "android", 1000)) === null)
ok(
  "verifyInteractive sigue el check del target activo",
  (await E.verifyInteractive(perTarget, "app", "ios", 1000)) === false &&
    (await E.verifyInteractive(perTarget, "app", "android", 1000)) === true,
)

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

// ═════════════════════════════════════════════════════════════════════════════
// Second review: locking, "starting", external servers, process groups, devices
// ═════════════════════════════════════════════════════════════════════════════

const fx = (name: string, manifest: unknown) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rundev-${name}-`))
  fs.mkdirSync(path.join(dir, ".opencode"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".opencode", "rundev.json"), JSON.stringify(manifest, null, 2))
  return { dir, loaded: findManifest(dir)! }
}
/** Live processes whose COMMAND starts with `needle` (not a shell that merely mentions it). */
const psLines = async (needle: string) =>
  (await E.run("/bin/ps", ["-axo", "pid=,command="])).out
    .split("\n")
    .filter((l) => l.trim().replace(/^\d+\s+/, "").startsWith(needle))
// Absolute path: a login shell (`sh -lc`, what `up` uses) resets PATH on Debian/Ubuntu, and a
// node installed by setup-node would not be found by a bare `node`.
const NODE = (await E.run("/bin/sh", ["-c", "command -v node"])).out.trim() || "node"
const slowServer = (port: number, bootMs: number) =>
  `"${NODE}" -e "setTimeout(()=>require('http').createServer((q,r)=>r.end('ok')).listen(${port},'127.0.0.1'),${bootMs})"`

// ── invalid JSON is not an empty manifest
const broken = fx("broken", { version: 1, services: { a: { kind: "process", up: "x" } } })
fs.writeFileSync(path.join(broken.dir, ".opencode", "rundev.json"), '<<<<<<< HEAD\n{ "services": {} }\n=======\n>>>>>>> x\n')
const brokenLoaded = findManifest(broken.dir)!
ok("a manifest with conflict markers reports invalid JSON", validate(brokenLoaded).some((p) => /invalid JSON/.test(p) && /conflict/.test(p)), validate(brokenLoaded).join(" · "))
ok("readJsonStrict tells missing from invalid", readJsonStrict(path.join(broken.dir, "nope.json")).state === "missing" && readJsonStrict(path.join(broken.dir, ".opencode", "rundev.json")).state === "invalid")
fs.writeFileSync(path.join(broken.dir, ".opencode", "rundev.local.json"), "{ nope")
let refused = false
try {
  E.writeLocalOverrides(broken.dir, { services: { a: { port: 1 } } })
} catch {
  refused = true
}
ok("writeLocalOverrides refuses to overwrite a broken local file", refused && fs.readFileSync(path.join(broken.dir, ".opencode", "rundev.local.json"), "utf8") === "{ nope")

// ── strict fields, requires, default@target
ok(
  "lintManifest flags invented fields and suggests the real one",
  lintManifest({ services: { api: { kind: "process", up: "x", healt: "u", dependsOn: ["db"] } } }).some((w) => /"healt".*health/.test(w)) &&
    lintManifest({ services: { api: { kind: "process", up: "x", dependsOn: ["db"] } } }).some((w) => /dependsOn/.test(w)),
)
ok("lintManifest is quiet about a valid manifest", lintManifest({ version: 1, services: { a: { kind: "process", up: "x", requires: [] } } }).length === 0)
const cyc = fx("cycle", { services: { a: { kind: "process", up: "x", requires: ["b"] }, b: { kind: "process", up: "x", requires: ["a"] } } })
ok("a requires cycle is a validation error", validate(cyc.loaded).some((p) => /cycle/.test(p)), validate(cyc.loaded).join(" · "))
const chain = fx("chain", {
  default: ["browser"],
  services: {
    db: { kind: "process", up: "x" },
    api: { kind: "process", up: "x", requires: ["db"] },
    web: { kind: "process", up: "x", requires: ["api"] },
    browser: { kind: "browser", url: "http://x", requires: ["web"] },
  },
})
ok("service-level requires order the start (db → api → web → browser)", JSON.stringify(E.expandRequires(chain.loaded, ["browser"])) === '["db","api","web","browser"]', JSON.stringify(E.expandRequires(chain.loaded, ["browser"])))
const defTarget = fx("deftarget", {
  default: ["app@ios"],
  services: { app: { kind: "interactive", up: "flutter run", targets: { android: {}, ios: {} } } },
})
ok("default entries may carry a target", validate(defTarget.loaded).length === 0 && defaultPlan(defTarget.loaded).targets.app === "ios", JSON.stringify(defaultPlan(defTarget.loaded)))
const badDefault = fx("baddefault", { default: ["app@watch"], services: { app: { kind: "interactive", up: "x", targets: { ios: {} } } } })
ok("default with a target that does not exist is rejected", validate(badDefault.loaded).some((p) => /no target "watch"/.test(p)), validate(badDefault.loaded).join(" · "))

// ── workspace
const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundev-ws-"))
for (const m of ["apps/api", "apps/app", "orphan"]) fs.mkdirSync(path.join(wsRoot, m, ".opencode"), { recursive: true })
fs.rmSync(path.join(wsRoot, "orphan", ".opencode"), { recursive: true })
for (const m of ["apps/api", "apps/app"]) fs.writeFileSync(path.join(wsRoot, m, ".opencode", "rundev.json"), JSON.stringify({ services: { s: { kind: "process", up: "x" } } }))
fs.writeFileSync(
  path.join(wsRoot, "rundev.workspace.json"),
  JSON.stringify({ members: ["apps/api", "apps/app", "orphan"], dependencies: { "apps/app": ["apps/api"], ghost: ["apps/api"], "apps/api": ["apps/app"] } }),
)
const wsLoaded = findWorkspace(wsRoot)!
ok("members may be paths and only those with their own manifest count", workspaceMembers(wsLoaded).map((m) => m.name).join() === "apps/api,apps/app")
ok("memberOf finds the member by the repo root, not by basename", memberOf(wsLoaded, path.join(wsRoot, "apps/app")) === "apps/app")
const wsProblems = validateWorkspace(wsLoaded)
ok("validateWorkspace: a member without manifest, a ghost, a cycle", wsProblems.some((p) => /orphan/.test(p)) && wsProblems.some((p) => /ghost/.test(p)) && wsProblems.some((p) => /cycle/.test(p)), wsProblems.join(" · "))

// ── the per-repo lock: parallel `up` of one service starts it once
const race = fx("race", { services: { w: { kind: "process", up: "sleep 33.5" } } })
const both = await Promise.all([E.up(race.loaded, ["w"], { waitMs: 200 }), E.up(race.loaded, ["w"], { waitMs: 200 })])
const raceActions = both.map((r) => r[0].action).sort().join()
ok("two parallel `up` start the service once (started + already)", raceActions === "already,started", raceActions)
ok("…and leave exactly one process behind", (await psLines("sleep 33.5")).length === 1, String((await psLines("sleep 33.5")).length))
await E.down(race.loaded, ["w"])

// ── a booting server is "starting", never restarted by a second `up`
if (hasLsof) {
  const slow = fx("slow", { services: { api: { kind: "process", up: slowServer(45941, 2500), port: 45941, health: "http://127.0.0.1:45941/" } } })
  const first = await E.up(slow.loaded, ["api"], { waitMs: 800 })
  const pid1 = E.readProc(slow.dir, "api")?.pid
  ok("a server that is still booting is `starting`, not `failed`", first[0].action === "starting", `${first[0].action}: ${first[0].detail.split("\n")[0]}`)
  const mid = await E.statusOf(slow.loaded, "api")
  ok("…and status says starting", mid.state === "starting", `${mid.state} · ${mid.detail}`)
  const second = await E.up(slow.loaded, ["api"], { waitMs: 8000 })
  const pid2 = E.readProc(slow.dir, "api")?.pid
  ok("a second `up` waits for it instead of restarting it", pid1 === pid2 && ["already", "started"].includes(second[0].action), `pid ${pid1}→${pid2} · ${second[0].action} · ${second[0].detail}`)
  await E.down(slow.loaded, ["api"])
  ok("…and `down` forgets the pidfile after a real stop", E.readProc(slow.dir, "api") === null)

  // ── somebody else already runs it, healthy: that is "already", not a conflict
  const ext = fx("ext", { services: { api: { kind: "process", up: slowServer(45942, 0), port: 45942, health: "http://127.0.0.1:45942/" } } })
  const outside = new Deno.Command(NODE, { args: ["-e", "require('http').createServer((q,r)=>r.end('ok')).listen(45942,'127.0.0.1')"] }).spawn()
  await E.sleep(1500)
  const extUp = await E.up(ext.loaded, ["api"], { waitMs: 500 })
  ok("a healthy server somebody else runs is `already`", extUp[0].action === "already" && /healthy/.test(extUp[0].detail), `${extUp[0].action}: ${extUp[0].detail}`)
  ok("…and rundev started nothing", E.readProc(ext.dir, "api") === null)
  outside.kill()
  await outside.status
}

// ── the launcher dies at once: that is `failed`, not `started`
const dead = fx("dead", { services: { w: { kind: "process", up: "exit 3" } } })
const deadUp = await E.up(dead.loaded, ["w"], { waitMs: 300 })
ok("a command that exits at once is not reported as started", deadUp[0].action === "failed", `${deadUp[0].action}: ${deadUp[0].detail.split("\n")[0]}`)

// ── children that outlive their launcher are still the service (and `down` stops them)
const orphan = fx("orphan", { services: { w: { kind: "process", up: "sleep 44.5 & exit 0" } } })
await E.up(orphan.loaded, ["w"], { waitMs: 100 })
await E.sleep(400)
const orphanSt = await E.statusOf(orphan.loaded, "w")
ok("a launcher that exited with live children still counts as running", orphanSt.state === "running" && /launcher exited/.test(orphanSt.detail), `${orphanSt.state} · ${orphanSt.detail}`)
await E.down(orphan.loaded, ["w"])
await E.sleep(300)
ok("`down` stops the children of a dead launcher", (await psLines("sleep 44.5")).length === 0)

// ── devices: the declared AVD / simulator, and `down` only touches what rundev booted
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "rundev-bin-"))
const adbLog = path.join(bin, "adb.log")
fs.writeFileSync(
  path.join(bin, "adb"),
  `#!/bin/sh
case "$*" in
  "devices") printf 'List of devices attached\\nemulator-5554\\tdevice\\nemulator-5556\\tdevice\\n' ;;
  "-s emulator-5554 emu avd name") printf 'Another_Project_AVD\\nOK\\n' ;;
  "-s emulator-5556 emu avd name") printf 'Pixel_8_API_36\\nOK\\n' ;;
  *"emu kill") echo "$*" >> "${adbLog}" ;;
esac
exit 0
`,
)
fs.chmodSync(path.join(bin, "adb"), 0o755)
const simList = (rows: string[]) => `-- iOS 27.0 --\n${rows.join("\n")}\n`
fs.writeFileSync(
  path.join(bin, "xcrun"),
  `#!/bin/sh
case "$*" in
  "simctl list devices booted") printf '%s' '${simList(["    iPhone 17 Pro (AAAAAAAA-0000-0000-0000-000000000001) (Booted) ", "    iPhone 17 (BBBBBBBB-0000-0000-0000-000000000002) (Booted) "])}' ;;
  *"shutdown"*) echo "$*" >> "${adbLog}" ;;
esac
exit 0
`,
)
fs.chmodSync(path.join(bin, "xcrun"), 0o755)
const oldPath = process.env.PATH
process.env.PATH = `${bin}:${oldPath}`
process.env.RUNDEV_XCRUN = path.join(bin, "xcrun")

const dev = fx("devices", {
  services: {
    emulator: { kind: "emulator", avd: "pixel_8_api_36" },
    simulator: { kind: "simulator", device: "iPhone 17" },
    app: {
      kind: "interactive",
      up: "flutter run",
      defaultTarget: "android",
      targets: { android: { requires: ["emulator"] }, ios: { requires: ["simulator"] } },
    },
  },
})
const androidPlan: any = await E.launchPlan(dev.loaded, "app", dev.loaded.manifest.services.app, "android")
ok("two emulators: the launch goes to the DECLARED AVD (case-insensitive), not the first", androidPlan.command === "flutter run -d emulator-5556", androidPlan.command)
const iosPlan: any = await E.launchPlan(dev.loaded, "app", dev.loaded.manifest.services.app, "ios")
ok("two simulators: the launch goes to the declared one", iosPlan.command === "flutter run -d BBBBBBBB-0000-0000-0000-000000000002", iosPlan.command)
ok("emulator status matches the AVD ignoring case", (await E.statusOf(dev.loaded, "emulator")).detail.includes("emulator-5556"))
ok("simulator status matches the declared device by name", (await E.statusOf(dev.loaded, "simulator")).detail.includes("iPhone 17 ("))

const stale = fx("stalepin", {
  services: { emulator: { kind: "emulator", avd: "pixel_8_api_36" }, app: { kind: "interactive", up: "flutter run", targets: { android: { requires: ["emulator"], device: "emulator-5560" } } } },
})
const stalePlan: any = await E.launchPlan(stale.loaded, "app", stale.loaded.manifest.services.app, "android")
ok("a pinned serial that is not connected is ignored in favour of the AVD", stalePlan.command === "flutter run -d emulator-5556", stalePlan.command)

const missing = fx("missingavd", {
  services: { emulator: { kind: "emulator", avd: "not_connected" }, app: { kind: "interactive", up: "flutter run", targets: { android: { requires: ["emulator"] } } } },
})
const missingPlan: any = await E.launchPlan(missing.loaded, "app", missing.loaded.manifest.services.app, "android")
ok("an AVD that is not connected gives no -d and says so (never another emulator)", missingPlan.command === "flutter run" && /not_connected/.test(missingPlan.deviceWarning), `${missingPlan.command} · ${missingPlan.deviceWarning}`)

const adbKills = () => (fs.existsSync(adbLog) ? fs.readFileSync(adbLog, "utf8").trim().split("\n").filter(Boolean) : [])
const downNoMarker = await E.down(dev.loaded, ["emulator", "simulator"])
await E.sleep(400)
ok(
  "`down` leaves alone an emulator/simulator rundev did not boot",
  adbKills().length === 0 && downNoMarker.every((r) => /not started by rundev/.test(r.detail)),
  `${downNoMarker.map((r) => r.detail).join(" | ")} · kills: ${adbKills().length}`,
)
E.writeDevice(dev.dir, { name: "emulator", kind: "emulator", id: "emulator-5556", label: "pixel_8_api_36", startedAt: Date.now() })
E.writeDevice(dev.dir, { name: "simulator", kind: "simulator", id: "BBBBBBBB-0000-0000-0000-000000000002", label: "iPhone 17", startedAt: Date.now() })
await E.down(dev.loaded, ["emulator", "simulator"])
await E.sleep(500)
const kills = adbKills()
ok(
  "…and with the marker it stops exactly that one, not the neighbours",
  kills.length === 2 && kills.some((k) => k.includes("emulator-5556")) && !kills.some((k) => k.includes("5554")) && kills.some((k) => k.includes("BBBBBBBB")) && !kills.some((k) => k.includes("AAAAAAAA")),
  kills.join(" | "),
)
ok("…and forgets the markers", E.readDevice(dev.dir, "emulator") === null && E.readDevice(dev.dir, "simulator") === null)
process.env.PATH = oldPath
delete process.env.RUNDEV_XCRUN

// ── what does not depend on each other starts at the same time
//        b ─┐
//           ├─► d        b and c boot in ~2.2 s each: in series that is 4.4 s, in parallel ~2.2 s
//        c ─┘
const par = fx("parallel", {
  services: {
    b: { kind: "process", up: slowServer(45943, 2200), port: 45943, health: "http://127.0.0.1:45943/" },
    c: { kind: "process", up: slowServer(45944, 2200), port: 45944, health: "http://127.0.0.1:45944/" },
    d: { kind: "process", up: "sleep 55.5", requires: ["b", "c"] },
  },
})
const t0 = Date.now()
const parUp = await E.up(par.loaded, ["d"], { waitMs: 9000 })
const took = Date.now() - t0
ok("b and c come up before d, in dependency order", parUp.map((r) => r.name).join() === "b,c,d" && parUp.every((r) => r.action === "started"), parUp.map((r) => `${r.name}:${r.action}`).join(" "))
// Structural, not a stopwatch: in parallel BOTH start before EITHER is ready (in series b would be ready first).
const parEvents = fs
  .readFileSync(path.join(par.dir, ".opencode", ".rundev", "events.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l))
const seqOf = (service: string, re: RegExp) => parEvents.find((e) => e.service === service && re.test(e.message ?? ""))?.seq ?? Infinity
const bothStarted = Math.max(seqOf("b", /^starting/), seqOf("c", /^starting/))
const firstReady = Math.min(seqOf("b", /ready$/), seqOf("c", /ready$/))
ok("independent services boot at the same time (both start before either is ready)", bothStarted < firstReady, `starts ≤ #${bothStarted}, first ready #${firstReady} · ${took} ms`)
await E.down(par.loaded, ["d", "b", "c"])

// ── a requirement that failed is not run over
const gate = fx("gate", {
  services: {
    db: { kind: "process", up: "exit 7" },
    api: { kind: "process", up: "sleep 56.5", requires: ["db"] },
  },
})
const gateUp = await E.up(gate.loaded, ["api"], { waitMs: 300 })
ok("a dependent is blocked when its requirement failed", gateUp[0].action === "failed" && gateUp[1].action === "blocked" && /requires db, which failed/.test(gateUp[1].detail), gateUp.map((r) => `${r.name}:${r.action}`).join(" "))
ok("…and it was never started", E.readProc(gate.dir, "api") === null && (await psLines("sleep 56.5")).length === 0)

// ── a service already tried earlier in the run is not tried twice
const tried = fx("tried", { services: { db: { kind: "process", up: "sleep 57.5" }, api: { kind: "process", up: "sleep 58.5", requires: ["db"] } } })
const priorFail = { name: "db", action: "failed" as const, detail: "emulator did not boot" }
const triedUp = await E.up(tried.loaded, ["api"], { waitMs: 200, attempted: new Map([["db", priorFail]]) })
ok("a failed `attempted` service is neither retried nor started over", triedUp[0] === priorFail && triedUp[1].action === "blocked" && E.readProc(tried.dir, "db") === null)

// ── a port held by Docker's proxy is reported by CONTAINER (the pid is just "com.docker.backend")
{
  const dbin = fs.mkdtempSync(path.join(os.tmpdir(), "rundev-docker-"))
  fs.writeFileSync(
    path.join(dbin, "docker"),
    `#!/bin/sh\ncase "$*" in\n  *publish=3307*) echo "otherapp-mysql-1" ;;\nesac\nexit 0\n`,
  )
  fs.chmodSync(path.join(dbin, "docker"), 0o755)
  const keep = process.env.PATH
  process.env.PATH = `${dbin}:${keep}`
  ok("dockerContainersOnPort names the container that publishes the host port", (await E.dockerContainersOnPort(3307)).join() === "otherapp-mysql-1")
  ok("…and nothing for a port nobody publishes", (await E.dockerContainersOnPort(3306)).length === 0)
  const msg = E.portConflictDetail({ port: 3307, free: false, pids: [1035], containers: ["otherapp-mysql-1"] })
  ok("the conflict names the container and says what to do", /Docker container otherapp-mysql-1/.test(msg) && /docker stop/.test(msg), msg)
  process.env.PATH = keep
}

// ── a simulator name from another machine fails at once, and says which ones exist here
{
  const xbin = fs.mkdtempSync(path.join(os.tmpdir(), "rundev-xcrun-"))
  fs.writeFileSync(
    path.join(xbin, "xcrun"),
    `#!/bin/sh
case "$*" in
  "simctl boot"*) echo "Invalid device or device pair: iPhone 17 Pro" >&2; exit 149 ;;
  "simctl list devices available") printf '== Devices ==\\n-- iOS 27.0 --\\n    iPhone 17 (13F9BFC9-0D1B-4D58-8A6F-60DE568D8F7E) (Shutdown) \\n    iPhone Air (D3AEFA33-45EB-41E9-AB43-CDF58BFA3B4F) (Shutdown) \\n' ;;
  "simctl list devices booted") printf '== Devices ==\\n' ;;
esac
exit 0
`,
  )
  fs.chmodSync(path.join(xbin, "xcrun"), 0o755)
  process.env.RUNDEV_XCRUN = path.join(xbin, "xcrun")
  const wrong = fx("wrongsim", { services: { simulator: { kind: "simulator", device: "iPhone 17 Pro", waitMs: 90_000 } } })
  const t = Date.now()
  const r = await E.up(wrong.loaded, ["simulator"], {})
  ok("an invalid simulator fails immediately, not after the 90 s wait", r[0].action === "failed" && Date.now() - t < 8000, `${r[0].action} in ${Date.now() - t} ms`)
  ok("…and names the simulators that exist on this machine", /available here: iPhone 17, iPhone Air/.test(r[0].detail) && /rundev\.local\.json/.test(r[0].detail), r[0].detail)
  delete process.env.RUNDEV_XCRUN
}

// ── the launcher never types into "the frontmost app"
const srcOf = (f: string) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")
// (the comments explain the old bug in prose; what must never come back is the CALL)
ok(
  "no source file types into the frontmost app through System Events",
  ["terminal.ts", "ghostty.ts", "engine.ts", "index.ts"].every(
    (f) => !/application "System Events"|keystroke\s+["`$(]|key code\s+\d/.test(srcOf(f)),
  ),
)

console.log(`\n${fails === 0 ? "TODO OK ✔" : `${fails} FALLO(S) ✗`}`)
Deno.exit(fails === 0 ? 0 : 1)
