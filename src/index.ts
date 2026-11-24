/**
 * index.ts — the server plugin: one command for the user, tools for the agent.
 *
 * The command does the work and publishes its output through
 * `.opencode/.rundev/events.jsonl`; the TUI plugin renders it (toasts +
 * dialog). Nothing is sent to the model, so `/rundev` costs zero tokens.
 */

import { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import path from "node:path"
import {
  LOCAL_REL,
  MANIFEST_REL,
  WORKSPACE_REL,
  defaultPlan,
  dependencyOrder,
  diffManifest,
  findManifest,
  findWorkspace,
  lintManifest,
  membersWithManifest,
  memberOf,
  mergeLocal,
  patchManifest,
  readJsonStrict,
  validate,
  validateWorkspace,
  workspaceMembers,
  type Loaded,
  type LoadedWorkspace,
  type Manifest,
  type ManifestDiff,
  type Member,
} from "./manifest.ts"
import * as E from "./engine.ts"
import { scan } from "./scan.ts"
import { listTerminals, pickHostTerminal } from "./ghostty.ts"
import { copyLine, detectStrategy, openPanel, parseStrategy, type TerminalStrategy } from "./terminal.ts"
import { AGENT_SKILL, MANIFEST_SKILL } from "./skills.ts"

/** Verbs whose report is also mirrored into the session timeline. */
const TIMELINE_VERBS = new Set(["init", "up", "down", "status", "doctor", "env", "uninstall"])
/** Verbs that can address several repos of a workspace. */
const WORKSPACE_VERBS = new Set(["status", "up", "down", "logs", "env", "doctor"])

// ────────────────────────────────────────────────────────────────── arguments

interface Token {
  /** `member:` prefix, when the token names a repo of the workspace. */
  member?: string
  /** Service name (or `.env` section for `env`); empty when only a member was named. */
  name: string
  target?: string
}

/** `svc`, `svc@target`, `member`, `member:svc`, `member:svc@target`. */
function parseArgs(argv: string[]) {
  const tokens: Token[] = []
  const flags = new Set<string>()
  for (const a of argv) {
    if (a.startsWith("--")) {
      flags.add(a.slice(2))
      flags.add(a.slice(2).split("=")[0])
      continue
    }
    const at = a.indexOf("@")
    const left = at < 0 ? a : a.slice(0, at)
    const target = at < 0 ? undefined : a.slice(at + 1) || undefined
    const colon = left.indexOf(":")
    if (colon > 0) tokens.push({ member: left.slice(0, colon), name: left.slice(colon + 1), target })
    else if (left) tokens.push({ name: left, target })
  }
  const services = tokens.filter((t) => t.name).map((t) => t.name)
  const targets: Record<string, string> = {}
  for (const t of tokens) if (t.name && t.target) targets[t.name] = t.target
  return { tokens, services, targets, flags }
}

function flagValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

/** Tool inputs are plain names: a `--flag` smuggled into `services` would be parsed as one. */
const plainNames = (values: unknown): string[] =>
  (Array.isArray(values) ? values : []).map(String).filter((v) => v && !v.startsWith("-"))

const isInside = (parent: string, child: string) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

// ────────────────────────────────────────────────────────────────── workspace

interface WsCtx {
  ws: LoadedWorkspace
  members: Member[]
  /** The member whose repo the session is in; undefined at the workspace root. */
  me?: string
}

/** The workspace around `dir`, when `dir` is its root or one of its members. */
function wsContext(dir: string): WsCtx | null {
  const ws = findWorkspace(dir)
  if (!ws) return null
  const members = workspaceMembers(ws)
  if (members.length === 0) return null
  const own = findManifest(dir)
  const me = own ? memberOf(ws, own.root) : undefined
  // a repo that merely lives under a workspace folder, without being a member, is a plain repo
  if (own && !me) return null
  return { ws, members, me }
}

/** A member by the exact string in `members`, or by its directory name when that is unique. */
function findMember(c: WsCtx, key: string): Member | undefined {
  const exact = c.members.find((m) => m.name === key)
  if (exact) return exact
  const byBase = c.members.filter((m) => path.basename(m.name) === key)
  return byBase.length === 1 ? byBase[0] : undefined
}

interface Sel {
  member: Member
  names: string[]
  targets: Record<string, string>
}

/**
 * Turns what was typed into repos and services. The same words work from the
 * workspace root and from inside any member — "the api and the app on ios" is
 * the same request in both places:
 *   `member:service@t` · `member` · a service of THIS repo · a service declared by
 *   exactly one other member · `--all`.
 */
function resolveTokens(c: WsCtx, tokens: Token[], flags: Set<string>): { selection: Map<string, Sel>; errors: string[] } {
  const selection = new Map<string, Sel>()
  const errors: string[] = []
  const pick = (member: Member): Sel => {
    let sel = selection.get(member.name)
    if (!sel) selection.set(member.name, (sel = { member, names: [], targets: {} }))
    return sel
  }
  const own = c.me ? c.members.find((m) => m.name === c.me) : undefined
  const add = (member: Member, t: Token) => {
    const sel = pick(member)
    if (t.name && !sel.names.includes(t.name)) sel.names.push(t.name)
    if (t.name && t.target) sel.targets[t.name] = t.target
  }
  if (flags.has("all")) c.members.forEach(pick)
  for (const t of tokens) {
    if (t.member) {
      const m = findMember(c, t.member)
      if (m) add(m, t)
      else errors.push(`${t.member}: no such member`)
      continue
    }
    if (own?.loaded.manifest.services[t.name]) {
      add(own, t)
      continue
    }
    const asMember = findMember(c, t.name)
    if (asMember) {
      pick(asMember)
      continue
    }
    const owners = c.members.filter((m) => m.loaded.manifest.services[t.name])
    if (owners.length === 1) add(owners[0], t)
    else if (owners.length > 1) errors.push(`${t.name} is declared by ${owners.map((o) => o.name).join(", ")} — say which: ${owners[0].name}:${t.name}`)
    else errors.push(`${t.name} is neither a member nor a service here`)
  }
  // inside a member, naming nothing means "this repo"
  if (selection.size === 0 && own && tokens.length === 0) pick(own)
  return { selection, errors }
}

/** A token that points outside the repo the session is in. */
function isForeign(c: WsCtx, t: Token): boolean {
  if (t.member) return findMember(c, t.member)?.name !== c.me
  const own = c.members.find((m) => m.name === c.me)
  if (own?.loaded.manifest.services[t.name]) return false
  return Boolean(findMember(c, t.name)) || c.members.some((m) => m.loaded.manifest.services[t.name])
}

/** One line per service: `postgres(compose :5432), app(interactive targets[android|ios])`. */
function summarize(loaded: Loaded): string {
  return Object.entries(loaded.manifest.services)
    .map(([name, svc]) => {
      const port = svc.port ? ` :${svc.port}` : ""
      const targets = svc.targets ? ` targets[${Object.keys(svc.targets).join("|")}]` : ""
      return `${name}(${svc.kind}${port}${targets})`
    })
    .join(", ")
}

interface Catalog {
  /** What this location declares, for the namespace and tool descriptions. */
  text: string
}

function describeLocation(dir: string): Catalog {
  const c = wsContext(dir)
  const loaded = findManifest(dir)
  const firstTarget = (l: Loaded) => {
    const hit = Object.entries(l.manifest.services).find(([, svc]) => svc.targets)
    return hit ? `${hit[0]}@${Object.keys(hit[1].targets as object)[0]}` : (defaultPlan(l).names[0] ?? "")
  }
  if (c && !c.me) {
    const deps = Object.entries(c.ws.workspace.dependencies ?? {})
      .map(([member, needs]) => `${member} → ${needs.join(", ")}`)
      .join(" · ")
    const first = c.members[0]
    return {
      text:
        `workspace ${c.ws.workspace.name ?? path.basename(c.ws.root)} · ` +
        c.members.map((m) => `${m.name}[${summarize(m.loaded)}]`).join(" · ") +
        `${deps ? ` · dependencies (come up first): ${deps}` : ""}` +
        ` · call: tools.rundev.up({ services: ["${first.name}:${firstTarget(first.loaded)}"] })`,
    }
  }
  if (loaded) {
    const plan = defaultPlan(loaded)
    const refs = (loaded.manifest.default?.length ? loaded.manifest.default : plan.names).join(", ")
    const siblings = c
      ? c.members
          .filter((m) => m.name !== c.me)
          .map((m) => `${m.name}[${Object.keys(m.loaded.manifest.services).join(", ")}]`)
          .join(" · ")
      : ""
    const deps = c && c.me ? (c.ws.workspace.dependencies?.[c.me] ?? []) : []
    return {
      text:
        `repo ${path.basename(loaded.root)}${c ? ` (member of workspace ${c.ws.workspace.name ?? path.basename(c.ws.root)})` : ""} · ` +
        `services: ${summarize(loaded) || "none"} · default: ${refs || "none"}` +
        `${deps.length ? ` · up brings ${deps.join(", ")} up first` : ""}` +
        `${siblings ? ` · other members (addressable as member:service): ${siblings}` : ""}` +
        ` · call: tools.rundev.up({ services: ["${firstTarget(loaded)}"] })`,
    }
  }
  return { text: "no rundev manifest here (init / apply create .opencode/rundev.json)" }
}

// ────────────────────────────────────────────────────────────────────── plugin

interface Io {
  signal?: AbortSignal
  onEvent?: (ev: E.RundevEvent) => void
  /** A person typed the command (a picker may open in their TUI); false for agent tools. */
  interactive?: boolean
}

/** Everything one invocation carries around. */
interface Rc {
  dir: string
  sessionID?: string
  argv: string[]
  tokens: Token[]
  services: string[]
  targets: Record<string, string>
  flags: Set<string>
  dryRun: boolean
  /** Rewrite the `.env` section a target needs (explicit; reported as `ANDROID → IOS`). */
  switchEnv: boolean
  /** `down` also closes the panel it stopped. */
  closePanel: boolean
  force: boolean
  waitMs?: number
  strategy?: TerminalStrategy
  direction?: "down" | "right"
  focus: boolean
  io: Io
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
        const ws = findWorkspace(dir)
        if (ws) {
          const members = workspaceMembers(ws)
          return {
            error:
              `no manifest here, but this is workspace "${ws.workspace.name ?? path.basename(ws.root)}" ` +
              `(${members.length} repos: ${members.map((m) => m.name).join(", ") || "none with a manifest"}).\n` +
              `${ws.parseError ? `${WORKSPACE_REL} is not valid JSON: ${ws.parseError}\n` : ""}` +
              `Workspace-wide: /rundev status --all · /rundev up --all · /rundev down --all\n` +
              `Repo-scoped: /rundev up <member>:<service>@<target> · or open a session inside one of the member repos.`,
          }
        }
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

    let catalog: Catalog = describeLocation(ctx.location?.directory ?? process.cwd())

    async function refreshCatalog() {
      catalog = describeLocation(ctx.location?.directory ?? process.cwd())
      try {
        await ctx.tool.reload()
      } catch {
        /* descriptions are a hint: never fail the work over them */
      }
    }

    // ── reports ────────────────────────────────────────────────────────────
    function statusTable(loaded: Loaded, list: E.ServiceStatus[], withHeader = true): string {
      const lines = withHeader ? [`rundev · ${path.basename(loaded.root)}`] : []
      const icon = (s: E.ServiceStatus) =>
        s.state === "running"
          ? "●"
          : s.state === "starting"
            ? "…"
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

    function resultIcon(action: E.UpResult["action"]): string {
      switch (action) {
        case "started":
        case "stopped":
          return "ok "
        case "already":
          return "=  "
        case "starting":
          return "~  "
        case "planned":
          return "···"
        case "failed":
          return "ERR"
        case "blocked":
          return "!  "
        default:
          return "-  "
      }
    }

    function resultLine(r: E.UpResult): string {
      return `  ${resultIcon(r.action)} ${r.name.padEnd(12)} ${r.action.padEnd(8)} ${r.detail}`
    }

    function upTable(results: E.UpResult[], title = "result"): string {
      return [`rundev · ${title}`, ...results.map(resultLine)].join("\n")
    }

    // ── interactive launches: open the panel, then verify the declared check ─
    function makeLaunchFn(loaded: Loaded, rc: Rc) {
      return async (plan: E.LaunchPlan): Promise<E.LaunchResult> => {
        const r = await openPanel({
          cwd: plan.cwd,
          command: plan.command,
          label: plan.label,
          strategy: rc.strategy,
          sessionID: rc.sessionID,
          dir: rc.dir,
          direction: rc.direction,
          focus: rc.focus,
        })
        if (!r.ok) return { ok: false, detail: r.detail }
        // Nothing was started: the command is on the clipboard (no scriptable terminal).
        if (r.manual) return { ok: true, manual: true, detail: r.detail }

        const verdict = await E.verifyInteractive(loaded, plan.name, plan.target, rc.waitMs, rc.io.signal)
        const device = plan.device ? ` · device ${plan.device}` : ""
        if (verdict === false) {
          // The panel is real and running: the app is still building, not lost.
          // (A panel opened without the scripting API cannot be told apart: copy the line.)
          if (r.terminalId) {
            return {
              ok: true,
              starting: true,
              terminalId: r.terminalId,
              detail: `${r.detail}${device} · its check does not pass yet (still building?) — it is running in the panel: check rundev_status in a bit, do not open it again`,
            }
          }
          const copied = await copyLine(r.line)
          return {
            ok: false,
            detail:
              `panel opened but the check did not pass yet (is it still building?)` +
              (copied ? " — the command is on the clipboard: paste it in the panel if it is empty" : ` — run it by hand: ${r.line}`),
          }
        }
        return {
          ok: true,
          terminalId: r.terminalId,
          detail: `${r.detail}${device}${verdict === true ? " · check passes" : ""} → ${r.line}`,
        }
      }
    }

    /** `force` is for what was asked for: a dependency brought up on the way is never relaunched. */
    function upMember(
      loaded: Loaded,
      names: string[],
      targets: Record<string, string>,
      rc: Rc,
      force = rc.force,
      attempted?: Map<string, E.UpResult>,
    ) {
      return E.up(loaded, names, {
        waitMs: rc.waitMs,
        targets,
        attempted,
        launch: makeLaunchFn(loaded, rc),
        force,
        dryRun: rc.dryRun,
        switchEnv: rc.switchEnv,
        signal: rc.io.signal,
        onEvent: rc.io.onEvent,
      })
    }

    // ── doctor ─────────────────────────────────────────────────────────────
    async function doctorReport(loaded: Loaded, rc: Rc): Promise<string> {
      const problems = validate(loaded)
      const raw = readJsonStrict(loaded.file)
      const warnings = raw.state === "ok" ? lintManifest(raw.value) : []
      const svcs = Object.values(loaded.manifest.services)
      const kinds = new Set(svcs.map((s) => s.kind))
      const need = new Set<string>()
      if (kinds.has("compose")) need.add("docker")
      if (kinds.has("emulator")) need.add("adb")
      if (kinds.has("simulator")) need.add("xcrun")
      if (svcs.some((s) => E.listenPort(s) !== undefined)) need.add("lsof")
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
      // Port preflight: a declared port that is already taken is the most
      // common reason `up` fails, so doctor answers it up front.
      const ports: string[] = []
      for (const [name, svc] of Object.entries(loaded.manifest.services)) {
        if (svc.kind === "browser") continue
        const port = E.listenPort(svc)
        if (port === undefined) continue
        const check = await E.checkPort(port)
        ports.push(`${name}:${port} ${check.free ? "free" : `taken by ${check.pids.join(", ") || "?"}`}`)
      }
      const simUi = kinds.has("simulator") ? await E.simulatorUiApp() : null
      // A device name copied from another machine is the commonest reason an app never starts.
      const machine: string[] = []
      if (kinds.has("simulator")) {
        const have = await E.detectSimulators()
        for (const [name, svc] of Object.entries(loaded.manifest.services)) {
          if (svc.kind !== "simulator" || !svc.device || E.isDeviceId(svc.device)) continue
          if (have.length && !have.some((n) => E.sameName(n, svc.device))) {
            machine.push(`${name}: simulator "${svc.device}" does not exist here (available: ${have.slice(0, 8).join(", ")})`)
          }
        }
      }
      const lines = [
        `rundev doctor · ${path.basename(loaded.root)}`,
        `manifest: ${path.relative(loaded.root, loaded.file)}${loaded.localApplied ? " (+ rundev.local.json)" : ""}`,
        `services: ${Object.keys(loaded.manifest.services).join(", ") || "(none)"}`,
        `problems: ${problems.length ? `\n- ${problems.join("\n- ")}` : "none ✔"}`,
      ]
      if (warnings.length) lines.push(`warnings (ignored at run time): \n- ${warnings.join("\n- ")}`)
      if (machine.length) lines.push(`this machine: \n- ${machine.join("\n- ")}`)
      lines.push(
        `binaries: ${found.length ? found.join(" · ") : "(none needed)"}`,
        `ports: ${ports.length ? ports.join(" · ") : "(none declared)"}`,
      )
      if (simUi) lines.push(`simulator ui: ${simUi.name}${simUi.path ? ` (${simUi.path})` : " (LaunchServices)"}`)
      lines.push(`env: ${env ? `sections ${env.sections.join(", ") || "(none)"} · active: ${env.active ?? "none"}` : "no .env"}`)
      if (kinds.has("interactive")) lines.push(await terminalReport(rc))
      return lines.join("\n")
    }

    /** How a panel would open right now, and why — the thing to look at when it opens in the wrong place. */
    async function terminalReport(rc: Rc): Promise<string> {
      const forced = rc.strategy
      const detected = forced ? { strategy: forced, detail: "requested with --strategy" } : await detectStrategy()
      if (detected.strategy !== "ghostty-api") {
        return `terminal: ${detected.strategy} — ${detected.detail}. Panels are not opened: the command is copied for you to paste.`
      }
      const terminals = await listTerminals()
      if (!terminals) return `terminal: ghostty-api — ${detected.detail}, but its terminals could not be read`
      const pick = await pickHostTerminal({ sessionID: rc.sessionID, dir: rc.dir, terminals })
      return pick.terminal
        ? `terminal: ghostty-api — a panel opens below ${pick.terminal.tty} (${pick.reason}); nothing is typed into any other window`
        : `terminal: ghostty-api — ${detected.detail}, but ${pick.reason}: the command would be copied instead`
    }

    // ── workspace verbs ────────────────────────────────────────────────────
    async function runWorkspace(verb: string, c: WsCtx, rc: Rc): Promise<string> {
      const title = `rundev · workspace ${c.ws.workspace.name ?? path.basename(c.ws.root)} (${c.members.length} repos)`
      const deps = c.ws.workspace.dependencies ?? {}
      const { selection, errors } = resolveTokens(c, rc.tokens, rc.flags)

      if (errors.length) {
        return [
          `not understood: ${errors.join("; ")}`,
          `members: ${c.members.map((m) => m.name).join(", ")}`,
          `services:`,
          ...c.members.map((m) => `  ${m.name}: ${Object.keys(m.loaded.manifest.services).join(", ")}`),
          "",
          `usage: ${verb} <member> · <service> · <member:service@target> · --all`,
        ].join("\n")
      }

      const everyone = () => c.members.forEach((m) => selection.set(m.name, { member: m, names: [], targets: {} }))

      // `status` and `doctor` are read-only: at the root, no names means everyone.
      if (selection.size === 0 && (verb === "status" || verb === "doctor" || verb === "env")) everyone()

      if (selection.size === 0) {
        // up / down / logs with nothing named, at the workspace root
        const lines = [
          title,
          "",
          `${verb} what? name the members or services you want (or --all for everything):`,
          `  ${verb} ${c.members.slice(0, 2).map((m) => m.name).join(" ")}`,
          ...(verb === "logs" ? [] : [`  ${verb} ${c.members[0].name}:<service>@<target>`]),
          "",
        ]
        for (const m of c.members) {
          lines.push(
            rc.io.interactive
              ? `  ${m.name}\n${statusTable(m.loaded, await E.statusAll(m.loaded), false)}`
              : `  ${m.name}: ${summarize(m.loaded)}`,
            "",
          )
        }
        // The engine runs in the server: ask this session's TUI to open the member
        // picker — only when a person typed the command. An agent calling a tool
        // must never pop a dialog up in somebody's terminal.
        if (rc.io.interactive && rc.sessionID && (verb === "up" || verb === "down")) {
          E.emit(c.ws.root, {
            type: "select",
            verb,
            workspace: c.ws.workspace.name ?? path.basename(c.ws.root),
            members: c.members.map((m) => m.name),
            sessionID: rc.sessionID,
          })
        }
        return lines.join("\n").trimEnd()
      }

      const t0 = Date.now()
      const lines = [title]
      const section = (m: Member, note = "") => lines.push("", `  ${m.name}${note}`)

      if (verb === "status") {
        const keys = [...selection.keys()]
        // inside a member, show what it depends on too: that is what `up` brought up
        if (c.me && selection.has(c.me)) for (const d of dependencyOrder(c.ws, c.me)) if (!keys.includes(d)) keys.push(d)
        for (const key of keys) {
          const m = findMember(c, key)
          if (!m) continue
          section(m, selection.has(key) ? "" : " (dependency)")
          lines.push(statusTable(m.loaded, await E.statusAll(m.loaded), false))
        }
        return lines.join("\n")
      }

      if (verb === "doctor") {
        const problems = validateWorkspace(c.ws)
        const out = [`rundev doctor · workspace ${c.ws.workspace.name ?? path.basename(c.ws.root)}`, `workspace problems: ${problems.length ? `\n- ${problems.join("\n- ")}` : "none ✔"}`]
        for (const sel of selection.values()) out.push("", await doctorReport(sel.member.loaded, rc))
        return out.join("\n")
      }

      if (verb === "logs") {
        const sel = [...selection.values()][0]
        const service = sel.names[0]
        if (!service) return `usage: logs <member:service> (or a service name) — ${sel.member.name} has: ${Object.keys(sel.member.loaded.manifest.services).join(", ")}`
        const tail = Number(flagValue(rc.argv, "tail") ?? 40)
        return `${sel.member.name}:${service}\n${await E.logs(sel.member.loaded, service, tail)}`
      }

      if (verb === "env") {
        const out = [title]
        for (const sel of selection.values()) {
          const info = E.envSections(sel.member.loaded.root)
          const wanted = rc.flags.has("read") ? undefined : sel.names[0]
          out.push("", `  ${sel.member.name}`)
          if (!info) out.push("    no .env")
          else if (!wanted) out.push(`    sections: ${info.sections.join(", ") || "(none)"} · active: ${info.active ?? "(none)"}`)
          else {
            const r = E.applyEnvSection(sel.member.loaded.root, wanted)
            out.push(`    ${r.ok ? `${r.detail} (was ${info.active ?? "none"})` : `could not change .env: ${r.detail}`}`)
          }
        }
        return out.join("\n")
      }

      if (verb === "up") {
        // Dependencies first (even when only the dependent was named), each once.
        const order: string[] = []
        const seen = new Set<string>()
        const visit = (key: string) => {
          if (seen.has(key)) return
          seen.add(key)
          for (const d of deps[key] ?? []) visit(d)
          order.push(key)
        }
        for (const key of selection.keys()) visit(key)
        const dependedOn = new Set(order.flatMap((k) => deps[k] ?? []))

        interface Job {
          key: string
          member?: Member
          sel?: Sel
          names: string[]
          targets: Record<string, string>
        }
        const jobs = new Map<string, Job>()
        for (const key of order) {
          const m = findMember(c, key)
          const sel = selection.get(key)
          if (!m) {
            jobs.set(key, { key, names: [], targets: {} })
            continue
          }
          const plan = defaultPlan(m.loaded)
          const explicit = Boolean(sel && sel.names.length > 0)
          // A repo that is both asked for and needed by another must come up whole —
          // in the order its manifest lists it (the database before the api), then the extras.
          const names = explicit
            ? [...new Set([...(dependedOn.has(key) ? plan.names : []), ...(sel as Sel).names])]
            : plan.names
          const targets = explicit ? { ...(dependedOn.has(key) ? plan.targets : {}), ...(sel as Sel).targets } : plan.targets
          jobs.set(key, { key, member: m, sel, names, targets })
        }

        // Repos that do not depend on each other come up at the same time; one that
        // depends on another waits for it. `level` = how many repos deep its chain goes.
        const level = new Map<string, number>()
        for (const key of order) {
          const upstream = (deps[key] ?? []).filter((d) => jobs.has(d))
          level.set(key, 1 + Math.max(-1, ...upstream.map((d) => level.get(d) ?? 0)))
        }
        const groups: string[][] = []
        for (const key of order) (groups[level.get(key) as number] ??= []).push(key)

        // A repo that has to WAIT for its dependencies does not have to wait to boot its
        // emulator or simulator: that is the slowest thing in the whole run (60–180 s)
        // and it needs nobody. Warm those up now, while the dependencies come up.
        const warm = new Map<string, Promise<E.UpResult[]>>()
        if (!rc.dryRun) {
          for (const job of jobs.values()) {
            if (!job.member || level.get(job.key) === 0) continue
            const services = job.member.loaded.manifest.services
            const devices = E.expandRequires(job.member.loaded, job.names, job.targets).filter(
              (n) => services[n]?.kind === "emulator" || services[n]?.kind === "simulator",
            )
            if (devices.length) warm.set(job.key, upMember(job.member.loaded, devices, {}, rc, false))
          }
        }

        const sections = new Map<string, string[]>()
        for (const group of groups) {
          if (!group) continue
          await Promise.all(
            group.map(async (key) => {
              const job = jobs.get(key) as Job
              if (!job.member) {
                sections.set(key, [`  !   ${key.padEnd(12)} no manifest found`])
                return
              }
              const warmed = (await warm.get(key)) ?? []
              const attempted = new Map(warmed.map((r) => [r.name, r]))
              const rs = await upMember(job.member.loaded, job.names, job.targets, rc, rc.force && Boolean(job.sel), attempted)
              // what the warm-up already reported (booted, or failed) is not reported twice
              sections.set(key, [...warmed, ...rs.filter((r) => !attempted.has(r.name))].map(resultLine))
            }),
          )
        }
        for (const key of order) {
          const job = jobs.get(key) as Job
          section(job.member ?? ({ name: key } as Member), job.sel ? "" : " (dependency)")
          lines.push(...(sections.get(key) ?? []))
        }
        lines.push("", `(${((Date.now() - t0) / 1000).toFixed(1)}s)`)
        return lines.join("\n")
      }

      // down: dependents before the things they depend on
      const chosen = [...selection.keys()]
      const ordered: string[] = []
      const seen = new Set<string>()
      const visit = (key: string) => {
        if (seen.has(key) || !chosen.includes(key)) return
        seen.add(key)
        for (const d of deps[key] ?? []) visit(d)
        ordered.push(key)
      }
      for (const key of chosen) visit(key)
      for (const key of ordered.reverse()) {
        const sel = selection.get(key) as Sel
        section(sel.member)
        const names = sel.names.length ? sel.names : E.allSet(sel.member.loaded)
        lines.push(...(await E.down(sel.member.loaded, names, { closePanel: rc.closePanel })).map(resultLine))
      }
      // what a member's `down` leaves behind
      if (c.me && selection.has(c.me)) {
        const left: string[] = []
        for (const d of dependencyOrder(c.ws, c.me)) {
          if (selection.has(d)) continue
          const m = findMember(c, d)
          if (!m) continue
          const up = (await E.statusAll(m.loaded)).filter((s) => s.state === "running" || s.state === "starting")
          if (up.length) left.push(`${d} (${up.map((s) => s.name).join(", ")})`)
        }
        if (left.length) lines.push("", `left running (workspace dependencies): ${left.join(" · ")} — down <member> to stop them`)
      }
      lines.push("", `(${((Date.now() - t0) / 1000).toFixed(1)}s)`)
      return lines.join("\n")
    }

    // ── one entry point for command + tools ────────────────────────────────
    async function execute(
      verb: string,
      argv: string[],
      sessionID?: string,
      payload?: any,
      io: Io = {},
    ): Promise<string> {
      const dir = await locationFor(sessionID)
      const parsed = parseArgs(argv)
      const { tokens, services, targets, flags } = parsed
      const waitMs = flagValue(argv, "wait") ? Number(flagValue(argv, "wait")) : undefined
      const split = flagValue(argv, "split")
      const rc: Rc = {
        dir,
        sessionID,
        argv,
        tokens,
        services,
        targets,
        flags,
        dryRun: flags.has("dry-run"),
        // Switching the `.env` section a target needs is explicit (`--switch-env`, or `switchEnv`
        // in the tool) and always reported as `.env ANDROID → IOS`; without it `up` only verifies.
        switchEnv: flags.has("switch-env"),
        closePanel: flags.has("close"),
        force: flags.has("force"),
        waitMs,
        strategy: parseStrategy(flagValue(argv, "strategy")) ?? parseStrategy(process.env.RUNDEV_STRATEGY),
        direction: split === "right" ? "right" : split === "down" ? "down" : undefined,
        focus: flags.has("focus"),
        io,
      }
      const dryRun = rc.dryRun

      if (verb === "init") {
        // A repo has ONE manifest. From a subfolder of a repo that already has it,
        // init must not plant a second one that would shadow it.
        const existingRoot = findManifest(dir)?.root
        const target = existingRoot ?? dir
        const s = scan(target)
        const request = String(payload?.request ?? "").trim()
        const guided = argv.includes("--guided") || request.length > 0
        // A parent directory holding member repos is a workspace, not a repo.
        if (!existingRoot && Object.keys(s.draft.services).length === 0) {
          const members = membersWithManifest(dir)
          if (members.length > 0) {
            const wsFile = path.join(dir, WORKSPACE_REL)
            if (fs.existsSync(wsFile)) {
              return `${WORKSPACE_REL} already exists — leaving it alone. Members found: ${members.join(", ")}`
            }
            const ws = { name: path.basename(dir), members, dependencies: {} }
            fs.writeFileSync(wsFile, `${JSON.stringify(ws, null, 2)}\n`)
            await refreshCatalog()
            return [
              `no services here: this looks like a workspace of ${members.length} repos with their own manifests.`,
              `wrote ${WORKSPACE_REL} with members: ${members.join(", ")}`,
              "",
              "Cross-repo dependencies are honoured from the root and from inside any member. Declare them like this:",
              '  "dependencies": { "my-app": ["my-api"] }',
              "",
              "Then: /rundev status · /rundev up my-app:app@ios · /rundev down --all",
            ].join("\n")
          }
        }
        const file = path.join(target, ".opencode", "rundev.json")
        const exists = fs.existsSync(file)
        const body = JSON.stringify(s.draft, null, 2)
        let detail: string
        if (exists) {
          const where = path.relative(dir, file) || path.relative(target, file)
          detail = `${where} already exists${target !== dir ? ` (the repo's manifest is at ${path.relative(dir, target) || "."} — a subfolder does not get its own)` : ""} — leaving it alone. This is what I detect now:\n\n${body}`
        } else {
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, `${body}\n`)
          detail = `wrote ${path.relative(dir, file)}. Review what the scan cannot know, then commit it so it travels with the repo:\n\n${body}`
        }
        const notes = [...s.notes]
        // The scan is read-only; gitignoring what init wrote belongs to init.
        for (const svc of Object.values(s.draft.services)) {
          if (svc.kind !== "browser") continue
          const profile = (svc.profile ?? ".opencode/.chrome-profile").replace(/\/$/, "")
          if (E.ensureGitignored(target, `${profile}/`)) notes.push(`browser: added \`${profile}/\` to .gitignore`)
        }
        // Machine values (AVD / simulator) are detected and written for you.
        const patch: any = { services: {} }
        if (Object.values(s.draft.services).some((x) => x.kind === "emulator")) {
          const avds = await E.detectAvds()
          if (avds.length) {
            patch.services.emulator = { avd: avds[0] }
            notes.push(
              `emulator.avd = ${avds[0]}${avds.length > 1 ? ` (others detected: ${avds.slice(1).join(", ")})` : ""}`,
            )
          } else {
            notes.push("no AVD detected (`flutter emulators`) — set emulator.avd by hand")
          }
        }
        if (Object.values(s.draft.services).some((x) => x.kind === "simulator")) {
          const sims = await E.detectSimulators()
          if (sims.length) {
            const pick = sims.find((x) => /iphone/i.test(x)) ?? sims[0]
            patch.services.simulator = { device: pick }
            notes.push(`simulator.device = ${pick}`)
          } else {
            notes.push("no simulator detected (`xcrun simctl list`) — set simulator.device by hand")
          }
        }
        if (Object.keys(patch.services).length) {
          try {
            E.writeLocalOverrides(target, patch)
            notes.push("written to .opencode/rundev.local.json (machine-specific, gitignored)")
          } catch (err) {
            notes.push(`could not write the machine overrides: ${(err as Error).message}`)
          }
        }

        // light the sidebar right away (snapshot of what is already running)
        const after = findManifest(target)
        if (after) {
          try {
            await E.statusAll(after)
          } catch {
            /* ignore */
          }
        }
        await refreshCatalog()
        const notesText = notes.length ? `\n\nTo complete:\n- ${notes.join("\n- ")}` : ""

        // Guided pass: hand the deterministic facts to the agent, which proposes the final
        // manifest, explains its choices and writes it with `rundev_apply` after approval.
        if (guided && sessionID) {
          const facts = JSON.stringify(
            { root: target, draft: s.draft, notes: s.notes, signals: s.signals, workspaceMembers: membersWithManifest(target) },
            null,
            2,
          )
          await ctx.session.prompt({
            sessionID,
            text: [
              "rundev guided init.",
              "",
              "This is the deterministic scan of the directory (facts, not prose). Review it, decide what the scan cannot know, and propose the final rundev manifest.",
              "```json",
              facts,
              "```",
              ...(request ? ["", `What the user asked for: ${request}`] : []),
              "",
              "Rules:",
              "- Never invent ports, paths or device names. If a value is unknown, say so and suggest one.",
              "- Every service must declare how it is checked and how it is stopped.",
              "- Prefer `compose` for containers, `process` for host servers, `interactive` for things that open a terminal (with `targets` + `requires`), `emulator`/`simulator` for devices.",
              "- Set `port` on every service that listens: rundev refuses to start on a taken port.",
              "- Use service-level `requires` for order (`web` requires `api`). Only the documented fields exist: anything else is ignored and rejected.",
              "- If there are member repos, propose `rundev.workspace.json` with `members` and only the `dependencies` you are sure about.",
              "",
              "Then: explain your choices in 3-5 lines (health path, what is optional, any cross-repo dependency), ask me to approve, and only after my confirmation write it with the `rundev_apply` tool (you can also pass `local` for machine values and `workspace` for the workspace file).",
              "A draft is already on disk; `rundev_apply` validates it before writing.",
            ].join("\n"),
          })
          return `${detail}${notesText}\n\nGuided pass handed to the agent — review its proposal here, then approve.`
        }

        return (
          `${detail}${notesText}\n\n` +
          "Want the agent to review and complete this, or to include something specific?\n" +
          "  /rundev init --guided\n" +
          "  /rundev init --guided include a local Chrome profile that opens with the app"
        )
      }

      if (verb === "uninstall") {
        const all = flags.has("all")
        const found = findManifest(dir)
        const root = found?.root ?? dir
        const loaded: Loaded =
          found ?? { root, file: path.join(root, ".opencode", "rundev.json"), manifest: { services: {} }, localApplied: false }
        const lines = [`rundev uninstall · ${path.basename(root)}${dryRun ? " (dry run)" : ""}`]

        if (found) {
          const statuses = await E.statusAll(loaded)
          const up = statuses.filter((s) => s.state === "running" || s.state === "unhealthy" || s.state === "starting")
          if (up.length === 0) {
            lines.push("  -  nothing running")
          } else if (dryRun) {
            lines.push(`  ··· would stop: ${up.map((s) => s.name).join(", ")}`)
          } else {
            for (const r of await E.down(loaded, up.map((s) => s.name))) {
              lines.push(`  ${r.action === "stopped" ? "ok " : "!  "} ${r.name.padEnd(12)} ${r.detail}`)
            }
          }
        }

        for (const row of E.cleanRepo(loaded, { all, dryRun })) {
          const icon = row.action === "removed" ? "ok " : row.action === "would-remove" ? "···" : " - "
          lines.push(`  ${icon} ${row.what}${row.detail ? ` — ${row.detail}` : ""}`)
        }

        lines.push("")
        lines.push("global (per machine — I never touch your config):")
        lines.push('  · remove "opencode-rundev" from the plugins list in ~/.config/opencode/opencode.json(c)')
        lines.push("  · delete ~/.config/opencode/plugins/rundev/ if you created a local dev bridge")
        return lines.join("\n")
      }

      // Facts for a guided pass or for an edit: what is committed, what this
      // machine overrides, what actually runs, and what the scan detects.
      if (verb === "scan") {
        const existing = findManifest(dir)
        const target = existing?.root ?? dir
        const s = scan(target)
        const committed = existing ? readJsonStrict(existing.file) : null
        const local = existing ? readJsonStrict(path.join(existing.root, LOCAL_REL)) : null
        const ws = findWorkspace(dir)
        return JSON.stringify(
          {
            root: target,
            manifest: committed?.state === "ok" ? committed.value : null,
            local: local?.state === "ok" ? local.value : null,
            ...(existing && local?.state === "ok" ? { effective: existing.manifest } : {}),
            problems: existing ? validate(existing) : [],
            draft: s.draft,
            notes: s.notes,
            signals: s.signals,
            workspace: ws ? { ...ws.workspace, root: ws.root, problems: validateWorkspace(ws) } : null,
            workspaceMembers: membersWithManifest(target),
          },
          null,
          2,
        )
      }

      if (verb === "apply") {
        const p = payload ?? {}
        const existing = findManifest(dir)
        const target = p.root ? path.resolve(String(p.root)) : (existing?.root ?? dir)
        // Writing a manifest is writing commands the next `up` will run: it stays
        // inside this session's directory, its repo and its workspace.
        const ws = findWorkspace(dir)
        const allowed = [dir, existing?.root, ws?.root].filter(Boolean) as string[]
        if (!allowed.some((a) => isInside(a, target))) {
          return `not written — ${target} is outside this session's directory and workspace (${allowed.map((a) => path.relative(dir, a) || ".").join(", ")})`
        }
        const file = path.join(target, MANIFEST_REL)
        const current = readJsonStrict(file)
        // A file that exists but does not parse (a git conflict, a typo) is NOT an
        // empty manifest: patching "on top of nothing" would erase whatever it held.
        if (current.state === "invalid" && !p.manifest) {
          return `not written — ${path.relative(dir, file) || MANIFEST_REL} is not valid JSON (${current.error}). Fix or restore it first; a patch must not overwrite it. To replace it on purpose, pass the full \`manifest\`.`
        }
        const committed: any = current.state === "ok" ? current.value : null
        const remove: string[] = Array.isArray(p.remove) ? p.remove : []
        const notes: string[] = []
        let next: Manifest
        let diff: ManifestDiff
        if (p.patch && typeof p.patch === "object") {
          const patched = patchManifest(committed, p.patch, remove)
          next = patched.manifest
          diff = patched
          notes.push(committed ? "patched the committed manifest" : "no manifest yet: the patch became the manifest")
        } else if (p.manifest && typeof p.manifest === "object") {
          // Full replacement: `remove` still applies, so a caller can pass one.
          next = { ...p.manifest, services: { ...(p.manifest.services ?? {}) } }
          const removed: string[] = []
          const missing: string[] = []
          for (const name of remove) {
            if (next.services[name]) {
              delete next.services[name]
              removed.push(name)
            } else missing.push(name)
          }
          if (removed.length && Array.isArray(next.default)) {
            next.default = next.default.filter((ref) => ref.split("@")[0] in next.services)
          }
          diff = diffManifest(committed, next, removed, missing)
          notes.push("replaced the whole manifest")
        } else {
          return "apply needs a `patch` (partial, merged) or a `manifest` (full)"
        }

        // Fields rundev does not know are ignored at run time: refusing the ones
        // this call introduces keeps an agent from believing it expressed something.
        const before = new Set(lintManifest(committed ?? {}))
        const unknown = [...lintManifest(next), ...(p.local ? lintManifest({ services: p.local.services ?? {} }) : [])].filter(
          (w) => !before.has(w),
        )
        if (unknown.length) {
          return `not written — fields rundev does not know (they would be ignored at run time):\n- ${[...new Set(unknown)].join("\n- ")}`
        }

        // Validate before writing: the effective manifest (committed + the local
        // overrides this call would write) is what a run would use.
        const effective = p.local ? mergeLocal(next, p.local) : next
        const problems = validate({ root: target, file, manifest: effective, localApplied: Boolean(p.local) })
        if (problems.length) {
          const hint =
            diff.removed.length > 0
              ? "\n(a removed service may still be listed in another service's `requires`: patch that too)"
              : ""
          return `not written — the manifest has problems:\n- ${problems.join("\n- ")}${hint}`
        }
        if (p.local) {
          const localRead = readJsonStrict(path.join(target, LOCAL_REL))
          if (localRead.state === "invalid") {
            return `not written — ${LOCAL_REL} is not valid JSON (${localRead.error}). Fix it first.`
          }
        }

        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
        if (p.local) E.writeLocalOverrides(target, p.local)
        if (p.workspace) {
          fs.writeFileSync(path.join(target, WORKSPACE_REL), `${JSON.stringify(p.workspace, null, 2)}\n`)
        }
        const written = [".opencode/rundev.json"]
        if (p.local) written.push(".opencode/rundev.local.json (machine)")
        if (p.workspace) written.push(WORKSPACE_REL)

        const lines = [
          diff.added.length ? `added: ${diff.added.join(", ")}` : "",
          diff.changed.length ? `changed: ${diff.changed.join(", ")}` : "",
          diff.defaultChanged ? "changed: default" : "",
          diff.removed.length ? `removed: ${diff.removed.join(", ")}` : "",
          diff.missing.length ? `not found to remove: ${diff.missing.join(", ")}` : "",
        ].filter(Boolean)

        const loaded = findManifest(target)
        if (!loaded) return `wrote ${written.join(" + ")} but could not read it back`
        try {
          await E.statusAll(loaded) // snapshot so the sidebar lights up
        } catch {
          /* ignore */
        }
        await refreshCatalog()
        return [
          `wrote ${written.join(" + ")} (${notes.join(" · ")})`,
          ...(lines.length ? lines : ["services: unchanged"]),
          "problems: none ✔",
          "",
          "next: rundev_status, then rundev_up for what changed",
        ].join("\n")
      }

      // ── several repos: the workspace root, or a member talking about another one ──
      if (WORKSPACE_VERBS.has(verb)) {
        const c = wsContext(dir)
        if (c) {
          const toWorkspace =
            !c.me || verb === "status" || verb === "up" || verb === "down" || flags.has("all") || tokens.some((t) => isForeign(c, t))
          if (toWorkspace) return runWorkspace(verb, c, rc)
        }
      }

      // ── one repo ────────────────────────────────────────────────────────
      const resolved = resolveManifest(dir)
      if ("error" in resolved) return resolved.error
      const loaded = resolved

      switch (verb) {
        case "status": {
          E.emit(loaded.root, { type: "event", level: "info", message: "checking…" })
          const list = await E.statusAll(loaded)
          return statusTable(loaded, list)
        }
        case "doctor":
          return doctorReport(loaded, rc)
        case "up": {
          const t0 = Date.now()
          const plan = defaultPlan(loaded)
          const names = services.length ? services : plan.names
          // a bare `up` honours the targets written in `default` ("app@ios"); a named service is what was typed
          const results = await upMember(loaded, names, services.length ? targets : { ...plan.targets, ...targets }, rc)
          return `${upTable(results, dryRun ? "plan" : "result")}\n\n(${((Date.now() - t0) / 1000).toFixed(1)}s)`
        }
        case "down": {
          const t0 = Date.now()
          // A bare `down` stops everything the manifest declares — and for a
          // device that means the one rundev booted, never "every emulator".
          const names = services.length ? services : E.allSet(loaded)
          const results = await E.down(loaded, names, { closePanel: rc.closePanel })
          return `${upTable(results)}\n\n(${((Date.now() - t0) / 1000).toFixed(1)}s)`
        }
        case "logs": {
          const name = services[0]
          if (!name) return "usage: /rundev logs <service>"
          const tail = Number(flagValue(argv, "tail") ?? 40)
          return await E.logs(loaded, name, tail)
        }
        case "env": {
          const info = E.envSections(loaded.root)
          if (!info) return "this repo has no .env"
          const section = services[0]
          const report = `sections: ${info.sections.join(", ") || "(none)"}\nactive: ${info.active ?? "(none)"}`
          if (!section || flags.has("read")) return report
          const r = E.applyEnvSection(loaded.root, section)
          return r.ok ? `${r.detail} (was ${info.active ?? "none"})` : `could not change .env: ${r.detail}`
        }
        default:
          return (
            `verbs: init · up · status · down · logs · doctor · env · uninstall\n` +
            `examples:\n  /rundev init --guided   (let the agent propose the manifest)\n  /rundev up\n  /rundev up app@ios\n  /rundev up --dry-run app@ios   (plan: ports, commands, device)\n  /rundev up app --force   (relaunch the panel it already opened)\n  /rundev up api app@ios   (from inside a workspace member: api may live in another member)\n  /rundev up acme-app:app@ios   (member:service@target)\n  /rundev down --all\n  /rundev logs api\n  /rundev uninstall --dry-run`
          )
      }
    }

    // ── user-facing command ────────────────────────────────────────────────
    await ctx.command.transform((editor) => {
      editor.add({
        name: "rundev",
        description: "Repo dev environment: init · up · status · down · logs · doctor · env · uninstall",
        execute: async ({ sessionID, prompt }: any) => {
          const raw = String(prompt?.text ?? "").trim()
          const argv = raw.split(/\s+/).filter(Boolean)
          const verb = argv[0] ?? "status"
          // `init <free text>` (or `-m "…"`): the request travels to the agent's guided pass
          const request =
            verb === "init"
              ? raw
                  .slice(raw.indexOf("init") + 4)
                  .replace(/(^|\s)(--guided|--all|-m)(?=\s|$)/g, " ")
                  .trim()
                  .replace(/^["']|["']$/g, "")
              : ""
          let report: string
          try {
            report = await execute(verb, argv.slice(1), sessionID, request ? { request } : undefined, { interactive: true })
          } catch (err) {
            report = `rundev failed: ${(err as Error).message}`
          }
          const root = await locationFor(sessionID).then((d) => findManifest(d)?.root ?? findWorkspace(d)?.root ?? d)
          E.emit(root, {
            type: "report",
            title: `rundev ${verb}`,
            text: report,
          })
          // keep the report in the conversation too (visible history + agent context)
          if (sessionID && TIMELINE_VERBS.has(verb)) E.pushToTimeline(sessionID, root, report)
        },
      })
    })

    // ── agent tools ────────────────────────────────────────────────────────
    const toolBase = {
      options: { namespace: "rundev", codemode: true as const },
    }
    /** The two calls the agent needs first are listed with their signature, not hidden behind a search. */
    const pinned = { options: { namespace: "rundev", codemode: true as const, pinned: true } }

    /** Throttled tool progress, so a 90 s simulator boot is not a silent call. */
    function progressFrom(context: any) {
      let last = 0
      return (ev: E.RundevEvent) => {
        if (ev.type !== "event" || !ev.message) return
        const now = Date.now()
        if (now - last < 1_500) return
        last = now
        try {
          void context?.progress?.({ status: ev.message })
        } catch {
          /* progress is a courtesy */
        }
      }
    }

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "rundev",
        description: `Local dev environment. ${catalog.text}. Start what is missing with up (it preflights ports and starts requires first); status shows what is up.`,
      })
      editor.add({
        ...pinned,
        name: "status",
        description: `Local environment status: what is up, who owns it, which ports are taken. In a workspace it shows every member. Changes nothing. ${catalog.text}`,
        input: {
          type: "object",
          properties: { all: { type: "boolean", description: "Every member of the workspace (the default at its root)" } },
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => ({
          content: await execute("status", input?.all ? ["--all"] : [], context?.sessionID),
        }),
      })
      editor.add({
        ...pinned,
        name: "up",
        description: [
          `Starts the missing local services declared in .opencode/rundev.json.`,
          `Services accept a target ("app@<target>") and, in a workspace, a member ("member:service@target"); a bare service name resolves to the member that declares it, from the root or from inside any member. Declared requires and workspace dependencies come up first, and every port is preflighted: a port taken by another process blocks the start instead of failing later.`,
          `Idempotent and safe to call in parallel: it never reopens a panel it already launched (force relaunches), and "starting" means it is booting — wait and check status, do not call it again. The app's panel opens in the terminal that hosts this session, never in another window. dryRun reports the plan without starting anything.`,
          catalog.text,
        ].join(" "),
        input: {
          type: "object",
          properties: {
            services: { type: "array", items: { type: "string" }, description: "Empty = the repo default. `app`, `app@ios`, `member`, `member:service@target`" },
            wait: { type: "number", description: "max ms to wait for readiness" },
            force: { type: "boolean", description: "Relaunch what is already up, interactive panels included" },
            dryRun: { type: "boolean", description: "Report ports, commands and the resolved device without starting anything" },
            switchEnv: {
              type: "boolean",
              description: "When the target needs another .env section (ANDROID/IOS), switch it instead of stopping. Use it when the user asked for that target; the answer reports `.env ANDROID → IOS`.",
            },
            all: { type: "boolean", description: "Every member of the workspace" },
          },
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const argv = plainNames(input?.services)
          if (Number(input?.wait) > 0) argv.push(`--wait=${Number(input.wait)}`)
          if (input?.force) argv.push("--force")
          if (input?.dryRun) argv.push("--dry-run")
          if (input?.switchEnv) argv.push("--switch-env")
          if (input?.all) argv.push("--all")
          return {
            content: await execute("up", argv, context?.sessionID, undefined, {
              signal: context?.signal,
              onEvent: progressFrom(context),
            }),
          }
        },
      })
      editor.add({
        ...toolBase,
        name: "down",
        description:
          "Stops what rundev started. With no argument it stops everything the manifest declares: processes, containers, the app's panel (Ctrl+C is sent to it) and an emulator or simulator only if rundev booted it (one you had open is left alone). In a workspace, name the members/services; the answer lists the dependencies it leaves running.",
        input: {
          type: "object",
          properties: {
            services: { type: "array", items: { type: "string" } },
            all: { type: "boolean", description: "Every member of the workspace" },
            closePanel: { type: "boolean", description: "Also close the app's panel once what ran in it has ended" },
          },
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => ({
          content: await execute(
            "down",
            [...plainNames(input?.services), ...(input?.all ? ["--all"] : []), ...(input?.closePanel ? ["--close"] : [])],
            context?.sessionID,
            undefined,
            { signal: context?.signal, onEvent: progressFrom(context) },
          ),
        }),
      })
      editor.add({
        ...toolBase,
        name: "logs",
        description: "Last lines of a service log. In a workspace: `member:service`, or just the service name.",
        input: {
          type: "object",
          properties: {
            service: { type: "string" },
            tail: { type: "number" },
          },
          required: ["service"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => ({
          content: await execute(
            "logs",
            [...plainNames([input?.service]), ...(Number(input?.tail) > 0 ? [`--tail=${Number(input.tail)}`] : [])],
            context?.sessionID,
          ),
        }),
      })
      editor.add({
        ...toolBase,
        name: "env",
        description:
          "Reads the .env sections and which one is active (every member in a workspace). It only writes with `switch: true` (explicit, because it rewrites the repo's .env) and reports `was ANDROID`. It reads sections, never values — secrets stay unread. In a workspace pass `section: \"member:SECTION\"`.",
        input: {
          type: "object",
          properties: {
            section: { type: "string", description: "Section to switch to (e.g. IOS, ANDROID)" },
            switch: { type: "boolean", description: "Actually switch the section (default: read only)" },
          },
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const section = plainNames([input?.section])[0]
          const argv = section ? [section] : []
          if (!(input?.switch && section)) argv.push("--read")
          return { content: await execute("env", argv, context?.sessionID) }
        },
      })
      editor.add({
        ...toolBase,
        name: "doctor",
        description:
          "Validates the manifest and the environment: problems, unknown fields, binaries, declared ports (free or taken by whom), the simulator UI and how an app panel would open right now. In a workspace it covers every member and the workspace file.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input, context: any) => ({
          content: await execute("doctor", [], context?.sessionID),
        }),
      })
      editor.add({
        ...toolBase,
        name: "scan",
        description:
          "Read-only facts for writing a rundev manifest: `manifest` is the committed .opencode/rundev.json, `local` the machine overrides, `effective` what actually runs, plus `problems`, the detected `draft`, `notes`, `signals` and the workspace. It never writes.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input, context: any) => ({
          content: await execute("scan", [], context?.sessionID),
        }),
      })
      editor.add({
        ...toolBase,
        // A manifest holds commands the next `up` will run: let the user's permission rules govern it.
        options: { ...toolBase.options, permission: "rundev_apply" },
        name: "apply",
        description:
          "Writes an APPROVED rundev manifest. Prefer `patch` for edits: it is deep-merged into the committed file (a target only changes the fields you send), so you never rewrite what you did not mean to touch. `manifest` replaces the whole file. `remove` drops services. It validates the merged result first and refuses to write a broken one, a field rundev does not know, or a patch over a file that is not valid JSON, then reports exactly what changed. Optionally `local` (machine overrides, merged into targets) and `workspace` (rundev.workspace.json).",
        input: {
          type: "object",
          properties: {
            patch: {
              type: "object",
              description:
                "Partial manifest merged into the committed file, e.g. { services: { app: { targets: { ios: { requires: ['simulator'] } } } } }",
            },
            manifest: { type: "object", description: "The full .opencode/rundev.json content (replaces the file)" },
            remove: { type: "array", items: { type: "string" }, description: "Service names to delete" },
            local: { type: "object", description: "Optional .opencode/rundev.local.json content" },
            workspace: { type: "object", description: "Optional rundev.workspace.json content" },
            root: { type: "string", description: "Target directory inside this session's repo or workspace (defaults to the repo's manifest root)" },
          },
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => ({
          content: await execute("apply", [], context?.sessionID, input),
        }),
      })
    })

    // ── the conventions travel with the plugin ─────────────────────────────
    const skillPath = (() => {
      try {
        return new URL(import.meta.url).pathname
      } catch {
        return "opencode-rundev/src/index.ts"
      }
    })()
    await ctx.skill.transform((editor) => {
      editor.add({
        id: "rundev",
        name: "rundev",
        description:
          "Start, check or stop the repo's dev environment (containers, dev servers, emulator/simulator, app, browser) through the rundev tools. Use it when the user says /rundev, asks to bring the project up, start the api or the app on ios/android, or something does not come up.",
        path: skillPath,
        content: AGENT_SKILL,
        // `id`/`name`/`path` are branded at the type level only (Effect brand): erased at runtime.
      } as any)
      editor.add({
        id: "rundev-manifest",
        name: "rundev manifest",
        description:
          "How to write or edit a rundev manifest: kinds, requires, checks, targets, workspace dependencies, and the scan → propose → approve → apply workflow.",
        path: skillPath,
        content: MANIFEST_SKILL,
      } as any)
    })
  },
})
