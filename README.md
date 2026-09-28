# opencode-rundev

**The VS Code "Run & Debug" for the terminal-first world.**

`rundev` brings a repo's dev environment up and down from OpenCode — containers, dev servers, the
emulator or simulator, and a browser with the project's own profile. No LLM in the loop, no `Ctrl+F5`,
no orphaned processes left behind.

```sh
/rundev up            # start whatever is missing (idempotent, non-blocking)
/rundev status        # what is up, who owns it, what was left orphaned
/rundev down          # stop what rundev started, verify, report
/rundev init          # scan the repo and draft the manifest (once per repo)
/rundev logs api      # follow a service log
/rundev doctor        # validate the manifest and the environment
```

## Why

Working with an agent in the terminal is great until you have to **bring the project up**:

- the agent improvises: it reads prose, guesses commands, waits too long and leaves things hanging;
- what the agent started cannot always be stopped later;
- opening the app ends up using **your** browser, with your session and your history.

`rundev` moves that into a declarative per-repo manifest plus a deterministic engine. The agent
decides *what* it needs; the command knows *how* it starts and how it stops.

## Install

```jsonc
// opencode.json(c)
{
  "plugins": ["opencode-rundev"]
}
```

Requirements: OpenCode ≥ 2.0, macOS. The terminal panel strategy targets Ghostty (`shift+cmd+D` split);
anywhere else it falls back to the clipboard / a new window.

## The manifest: `.opencode/rundev.json`

Every service declares **how it is checked** and **how it is stopped**. If it cannot be verified or
stopped, it does not belong in the manifest.

```jsonc
{
  "version": 1,
  "default": ["db", "api"],
  "services": {
    "db": { "kind": "compose", "file": "docker-compose.yml", "service": "mysql", "port": 3306 },
    "api": {
      "kind": "process",
      "up": "yarn dev",
      "port": 4000,
      "health": "http://localhost:4000/health"
    },
    "web": { "kind": "process", "up": "yarn dev -- --port 5173 --strictPort", "port": 5173 },
    "browser": { "kind": "browser", "url": "http://localhost:5173", "profile": ".opencode/.chrome-profile" },
    "app": {
      "kind": "interactive",
      "defaultTarget": "android",
      "targets": {
        "android": { "device": "emulator", "envSection": "ANDROID", "requires": ["emulator"] },
        "ios": { "device": "simulator", "envSection": "IOS", "requires": ["simulator"] }
      }
    },
    "emulator": { "kind": "emulator", "avd": "pixel_8_api_36", "waitMs": 180000 },
    "simulator": { "kind": "simulator", "device": "iPhone 16", "waitMs": 90000 }
  }
}
```

### Kinds

| kind | What it is | How it is checked | How it is stopped |
|---|---|---|---|
| `compose` | A `docker compose` service | `docker compose ps` | `docker compose stop` (never `-v`) |
| `process` | A host server (`yarn dev`, `deno task dev`) | pidfile + `check`/`health` | SIGTERM to the group, then verify |
| `browser` | Chrome with the project profile | `pgrep` by profile | closes only that profile |
| `interactive` | Something that opens a panel (`flutter run`) | not verifiable (no terminal IPC) | the panel is yours |
| `emulator` | An Android AVD | `adb devices` | `adb emu kill`, fire-and-forget (it may save a quick-boot snapshot) |
| `simulator` | An iOS simulator | `xcrun simctl list booted` | `xcrun simctl shutdown`, fire-and-forget |

### Machine overrides

Machine-specific values are detected for you: `init` runs `flutter emulators` / `xcrun simctl list`
and writes the AVD and simulator it finds into `.opencode/rundev.local.json` (gitignored). You can
still edit that file by hand — it just is not required.

```jsonc
{ "services": { "app": { "targets": { "android": { "device": "pixel_8_api_36" } } } } }
```

## Uninstall

```sh
/rundev uninstall --dry-run     # see what would be removed
/rundev uninstall               # stop what is running, remove state, chrome profile, .gitignore entries
/rundev uninstall --all         # also remove .opencode/rundev.json (the manifest you wrote)
```

It never touches your files: only the state it generated, the profile it created and the `.gitignore`
lines it added. The global bits (the `plugins` entry in your OpenCode config) are printed as
instructions, not modified.

## House rules

- **`up` is idempotent and non-blocking**: it starts and returns; whatever is already up is left alone.
- **`down` only stops what rundev started.** A process of yours holding the port is reported, never killed.
- **It never deletes volumes or data.**
- **`.env` is only verified**: if the active section does not match the requested target, `up` stops and
  tells you. Switching it is explicit (`/rundev env IOS`).
- **`requires` orders the launch**: the app pulls its `emulator`/`simulator` first, waiting (bounded) for
  boot before opening the panel.
- **A terminal panel inherits the cwd of the focused panel**, so every typed command starts with
  `cd '<repo-root>' &&` — validated before typing.

## Sidebar

The TUI plugin renders a live block in the sidebar with the repo's services and their state (from the
engine's snapshot plus pid liveness). Reports open in a dialog; progress shows up as toasts.

## Workspace (sibling repos / monorepo)

When several repos live together, each with its own manifest, drop a `rundev.workspace.json` at the
parent (`/rundev init` there writes one for you):

```jsonc
{
  "name": "bankyto",
  "members": ["bankyto-api", "bankyto-admin", "bankyto_app"],
  "dependencies": { "bankyto_app": ["bankyto-api"] }
}
```

- `members` are only used with `--all`: `/rundev status --all`, `/rundev up --all`, `/rundev down --all`.
- `dependencies` are only honoured **in workspace mode**: `/rundev up` inside `bankyto_app` brings
  `bankyto-api` up first (its own default set).
- Outside a workspace there is **no cross-repo awareness at all**: a repo only ever sees its own manifest.

## Timeline

Every report is mirrored into the session as a **shell message** (`!cat …`), exactly like running a
command with `!` in the composer: it stays in the history and the model reads it as context, with
**no extra model turn**. That is why `synthetic` messages are not used for this — those queue as user
messages and would be answered in the next turn.

## Tools for the agent

The same engine is exposed as tools, so the agent can start what it needs without burning turns
guessing: `rundev_status`, `rundev_up`, `rundev_down`, `rundev_logs`.

## Development

```sh
npm run typecheck                                          # types, including the TUI JSX
npm run smoke                                              # engine smoke test (no docker, no keystrokes)
node --experimental-strip-types dev/harness.ts <dir> "<verb>"   # plugin pre-flight, no server
```

The package ships TypeScript source (`src/`): OpenCode's plugin runtime loads it directly, the same
way it loads `.opencode/plugins/*.ts`.

## Status

v0.1 — developed and tested on macOS with Ghostty.
