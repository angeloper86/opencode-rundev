/**
 * skills.ts — the conventions that travel with the plugin, registered as skills so
 * any agent can follow them without the repo having to explain rundev.
 */

/** How to write and edit manifests. */
export const MANIFEST_SKILL = `# rundev manifest

How to write \`.opencode/rundev.json\` for a repo, and \`rundev.workspace.json\` for a group of repos.

## Contract
Every service declares how it is **checked** and how it is **stopped**. If it cannot be verified or
stopped it does not belong in the manifest. Never invent ports, paths or device names: if a value is
unknown, say so and suggest one. Only the fields below exist — anything else is **ignored at run time**
(so \`dependsOn\` orders nothing) and \`rundev_apply\` rejects it.

## Kinds
| kind | use for | required | checked with | stopped with |
|---|---|---|---|---|
| \`compose\` | a docker compose service | \`file\`, \`service\` | \`docker compose ps\` | \`docker compose stop\` (never \`-v\`) |
| \`process\` | a host server (\`yarn dev\`, \`deno task dev\`) | \`up\` | pidfile + \`check\`/\`health\` | SIGTERM to the process group |
| \`interactive\` | something that opens a terminal (\`flutter run\`) | \`up\` or \`targets\` | \`check\` when declared, else the panel itself | rundev forgets the panel (\`down\`) |
| \`browser\` | Chrome with a project profile | \`url\` or \`port\` | pgrep by profile | closes that profile |
| \`emulator\` | an Android AVD | \`avd\` | \`adb devices\` + \`adb emu avd name\` | \`adb emu kill\` — only the one rundev booted |
| \`simulator\` | an iOS simulator | \`device\` | \`xcrun simctl list booted\` | \`simctl shutdown\` — only the one rundev booted |

## Fields worth knowing
- \`port\`: the port the service **listens on** (compose: the published host port). \`up\` preflights it: a
  port taken by a process rundev did not start blocks the start (the pid is reported, nothing is killed).
  Without \`port\`, the port of \`health\` is used.
- \`check\`: shell command, exit 0 = up. Prefer a real health route over the bare root.
- \`health\`: URL probed with curl when there is no \`check\`.
- \`requires\`: services that must be up **first**, of any kind (\`web\` requires \`api\`; \`browser\` requires \`web\`).
  rundev starts them in that order; a cycle is a validation error.
- \`cwd\`: only for services living in another directory of the same repo (prefer workspace mode for other repos).
- \`default\`: what a bare \`up\` starts. An entry may carry a target: \`"app@ios"\`.
- \`interactive.targets\`: one entry per device/platform with optional \`device\`, \`envSection\` (the \`.env\`
  section it requires), \`launch\` (command override), \`check\` and \`requires\` (e.g. the emulator).
- \`target.device\` is optional and usually **omitted**: rundev resolves the real device from \`requires\`
  (the connected emulator whose AVD is the declared one, the booted simulator whose name is the declared
  one) and appends \`-d <device>\` to a \`flutter run\` that has none. Pin it only for a specific device.
- \`check\` on an \`interactive\` service makes a closed app detectable (e.g.
  \`adb -s <serial> shell pidof <applicationId>\`); on a service with \`targets\`, put it inside the target.
- \`stopMode: "fire-and-forget"\`: for services whose shutdown takes a while.
- \`waitMs\`: how long a booting service may take before it counts as unhealthy (default 60 s; emulators 180 s).

## Full example
\`\`\`jsonc
{
  "version": 1,
  "default": ["db", "api", "app@android"],
  "services": {
    "db": { "kind": "compose", "file": "docker-compose.yml", "service": "postgres", "port": 5432 },
    "api": { "kind": "process", "up": "deno task dev", "port": 8000, "health": "http://localhost:8000/health", "requires": ["db"] },
    "web": { "kind": "process", "up": "yarn dev --port 5173", "port": 5173, "requires": ["api"] },
    "browser": { "kind": "browser", "url": "http://localhost:5173", "profile": ".opencode/.chrome-profile", "requires": ["web"] },
    "app": {
      "kind": "interactive",
      "up": "flutter run",
      "defaultTarget": "android",
      "targets": {
        "android": { "requires": ["emulator"] },
        "ios": { "requires": ["simulator"], "envSection": "IOS" }
      }
    },
    "emulator": { "kind": "emulator", "avd": "<machine>" },
    "simulator": { "kind": "simulator", "device": "<machine>" }
  }
}
\`\`\`
Machine values (the AVD name, the simulator name/udid) belong in \`rundev.local.json\`, not here.

## Workflow for a new manifest
1. \`rundev_scan\` → the facts (draft, notes, signals, member repos). In Code Mode the tools are
   \`tools.rundev.scan\`, \`tools.rundev.apply\`, \`tools.rundev.up\`, …; outside it they are
   \`rundev_scan\`, \`rundev_apply\`, \`rundev_up\`.
2. Read the repo's \`AGENTS.md\`/\`README\` for what the scan cannot know (health route, optional services).
3. Propose the manifest, resolve every TODO, explain the non-obvious choices in a few lines.
4. Only after the user approves: \`rundev_apply\` with \`manifest\` (+ \`local\` for machine values,
   \`workspace\` for members/dependencies).

## Editing an existing manifest ("add the ios target", "add a worker", "change the port")
Never rewrite the file from memory. Prefer a **patch**: \`rundev_apply\` deep-merges it into the
committed \`.opencode/rundev.json\`, so a target changes only the fields you send and every other
service, \`requires\`, \`check\` and \`default\` entry is preserved.

1. \`rundev_scan\` → \`manifest\` (committed), \`local\` (machine), \`effective\` (what runs), \`problems\`.
2. Propose the **minimal patch** and explain it in 1-3 lines.
3. Only after the user approves:

| request | call |
|---|---|
| add a target | \`rundev_apply({ patch: { services: { app: { targets: { ios: { requires: ["simulator"], envSection: "IOS" } } } } } })\` |
| add a service | \`rundev_apply({ patch: { services: { worker: { kind: "process", up: "yarn worker", port: 4010, requires: ["db"] } }, default: ["db", "api", "worker"] } })\` |
| order two services | \`rundev_apply({ patch: { services: { web: { requires: ["api"] } } } })\` |
| change a port | \`rundev_apply({ patch: { services: { api: { port: 8001 } } } })\` |
| drop a service | \`rundev_apply({ patch: {}, remove: ["worker"] })\` (also removed from \`default\`) |
| machine value | \`rundev_apply({ patch: {}, local: { services: { app: { targets: { ios: { device: "<udid>" } } } } } })\` |
| start over | \`rundev_apply({ manifest: { ... } })\` (replaces the whole file) |

\`rundev_apply\` validates the merged result (all targets, \`requires\` and their cycles, \`defaultTarget\`,
ports, unknown fields) and **refuses to write** a broken one; it answers with what changed
(added/changed/removed). It also refuses to patch a file that is not valid JSON (a git conflict, a typo):
fix the file first. Then \`rundev_up\` for what changed — or \`rundev_down\` + \`rundev_up\` if a running service changed.

A project browser is \`{ "kind": "browser", "url": "http://localhost:<port>", "profile":
".opencode/.chrome-profile" }\`; add it to \`default\` when it should open with a bare \`up\`.

## Workspace
\`rundev.workspace.json\` at the parent directory:

\`\`\`jsonc
{ "name": "acme", "members": ["acme-api", "acme-app"], "dependencies": { "acme-app": ["acme-api"] } }
\`\`\`

\`members\` are directories (names or relative paths) that each carry their own manifest. \`dependencies\`
maps a member to the members that must be up first: \`up\` of \`acme-app\`, from the root or from inside it,
brings \`acme-api\` up first, in its own repo. Outside a workspace a repo only sees its own manifest.
`

/** How to DRIVE the environment. */
export const AGENT_SKILL = `# rundev: start, check and stop the dev environment

The repo's dev environment (containers, dev servers, emulator/simulator, browser) is declared in
\`.opencode/rundev.json\`. **Use the rundev tools instead of improvising commands.** If the manifest
declares a service, do not run \`docker compose up\`, \`yarn dev\` or \`flutter run\` by hand, and do not try
to open a terminal or type into one: rundev starts it, verifies its port and health, can stop it again,
and opens the app's panel in the right terminal itself.

\`/rundev\` is a **user** command, not something you execute. You drive the same engine with the tools.

## The calls you want
| call | what it does |
|---|---|
| \`status()\` | what is up, on which port, what owns it. Changes nothing. In a workspace: every member. |
| \`up({ services: ["app@ios"] })\` | starts what is missing **in order**: \`requires\` first (simulator → app), every port preflighted, bounded waits. |
| \`up({ services: ["api", "app@ios"] })\` | several services, each with its target. |
| \`up({ dryRun: true, services: ["app@ios"] })\` | the plan (ports, commands, device, \`.env\` warnings) **without starting anything**. |
| \`down({})\` | stops what rundev started: processes, containers, the app (Ctrl+C goes to **its panel**), and the emulator/simulator **it** booted. |
| \`logs({ service: "api" })\` | last lines of the service log. |
| \`up({ services: ["app@ios"], switchEnv: true })\` | same, and if the target needs another \`.env\` section (ANDROID → IOS) it switches it first and says so. |
| \`env({})\` | the \`.env\` sections and which one is active (never the values). |
| \`env({ section: "IOS", switch: true })\` | switches the section by itself (reports \`was ANDROID\`). |
| \`doctor({})\` | problems, unknown fields, ports, and where an app panel would open. |
| \`apply({ patch: {...} })\` | edits the manifest (see the \`rundev-manifest\` skill). |

In Code Mode the tools are \`tools.rundev.up(...)\`, \`tools.rundev.status()\`, …; outside it they are
\`rundev_up\` etc. Both take the same input. Parallel calls are safe: rundev serialises \`up\`/\`down\` per repo.
\`up\` itself starts what does not depend on each other **at the same time** (the emulator boots while the
database and the api come up), so one \`up\` with everything you need is faster than several in a row.

## Reading what \`up\` answers
| action | meaning | what you do |
|---|---|---|
| \`started\` | it was down and is up now (and answered its check) | go on |
| \`already\` | it was already up — also a server somebody else runs that answers its health check | go on |
| \`starting\` | alive and booting, not ready yet. **Not a failure.** | wait and call \`status\`; **do not call \`up\` again to "retry"** |
| \`planned\` | a \`dryRun\` plan | read it, then call \`up\` for real |
| \`blocked\` | a port is taken by a process rundev did not start, the \`.env\` section is wrong, or something it \`requires\` failed | see below |
| \`manual\` | no terminal could be scripted: the command is on the user's clipboard | tell the user to paste it; do not try to open a terminal |
| \`failed\` | it exited, or could not start | read the log lines in the answer, \`logs\`, then fix or ask |

## Reading a blocker
- **\`port <n> is already in use by pid …\`** — do not kill it: it is not ours. Report it to the user
  with the pid and let them decide (or change the port in the manifest).
- **\`target "ios" does not exist … (declared: android)\`** — the manifest lacks that target. Propose
  adding it with \`apply\` (a \`patch\`, not a full rewrite); do not launch the android one and call it iOS.
- **\`the .env has section ANDROID active and this target needs IOS\`** — the user asked for that target, so
  call \`up({ services: ["app@ios"], switchEnv: true })\`: it switches the section, launches, and the answer
  reports \`.env ANDROID → IOS\` (tell the user it changed). If the user did **not** ask for that target, ask
  first. Never edit or read \`.env\` yourself: the section switch only touches \`# SECTION\` comment lines, and the
  tools show section names, never values.
- **\`requires db, which failed: …\`** — the dependent was not started on purpose. Fix the failed one first.
- **\`simulator "…" is not booted: flutter will have to choose\`** — the plan found no device for that target.
- **\`the panel owns its output\`** — an interactive service has no captured log; use its \`check\` or the device.

## Workspace (sibling repos)
A workspace is a folder with \`rundev.workspace.json\` and several repos, each with its own manifest.
Every member is addressable **from anywhere in the workspace**, root or inside a member:
\`up({ services: ["acme-api", "acme-app:app@ios"] })\`. A bare service name resolves to the member that
declares it (\`api\`), and \`member:service\` disambiguates. \`dependencies\` come up first, even when you only name
the dependent. \`down\` stops only what you name; the answer lists the dependencies it leaves running.
At the workspace root \`status\` shows every member, and \`logs\`/\`env\`/\`doctor\` work with \`member:service\`.
`
