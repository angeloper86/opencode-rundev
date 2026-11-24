/**
 * manifest.ts — reading and validation of the `.opencode/rundev.json` manifest.
 *
 * A manifest declares SERVICES. At minimum every service declares how it is
 * checked (`check`) and how it is stopped (`down`/`stop`). Anything that cannot be
 * verified or stopped does not belong in the manifest.
 */

import fs from "node:fs"
import path from "node:path"

export type Kind = "compose" | "process" | "interactive" | "browser" | "emulator" | "simulator"

export interface Target {
  /** Device label (emulator-5554, iPhone 16, chrome…). */
  device?: string
  /** `.env` section this target requires (ANDROID, IOS…). Verified only. */
  envSection?: string
  /** Command to launch in the panel (defaults to the service `up`). */
  launch?: string
  /** Check command for this target (exit 0 = up); overrides the service `check`. */
  check?: string
  /** Other services that must be up first. */
  requires?: string[]
}

export interface Service {
  kind: Kind
  /** Service TCP port (verification and reporting). */
  port?: number
  /** Working directory relative to the repo root (e.g. "../acme-api"). */
  cwd?: string
  /** Command for `process` / `interactive` services. */
  up?: string
  /** Check command (exit 0 = up). */
  check?: string
  /** Health URL (probed with curl when there is no `check`). */
  health?: string
  /** Docker compose: file(s) and service. */
  file?: string | string[]
  service?: string
  /** emulator: AVD name (`flutter emulators`). */
  avd?: string
  /** simulator: device name (`xcrun simctl list`). */
  device?: string
  /** Browser: URL and profile. */
  url?: string
  profile?: string
  /** Interactive: per-device/platform variants. */
  targets?: Record<string, Target>
  defaultTarget?: string
  /** down: "wait" (por defecto) o "fire-and-forget" (emuladores). */
  stopMode?: "wait" | "fire-and-forget"
  /** Max wait for start/stop, in ms. */
  waitMs?: number
  /**
   * Services that must be up first (any kind). For an `interactive` service with
   * `targets`, the target's own `requires` are added on top of these.
   */
  requires?: string[]
}

export interface Manifest {
  version?: number
  /** Services a bare `up` starts. */
  default?: string[]
  services: Record<string, Service>
}

export interface Loaded {
  root: string
  file: string
  manifest: Manifest
  /** Machine overrides (`rundev.local.json`), already applied. */
  localApplied: boolean
  /** The committed or local file exists but is not valid JSON (conflict markers, a typo…). */
  parseError?: string
}

export const MANIFEST_REL = path.join(".opencode", "rundev.json")
export const LOCAL_REL = path.join(".opencode", "rundev.local.json")

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

/** Reads a JSON file, `null` when it is missing or broken (used by scan/apply). */
export function readJsonFile(file: string): any | null {
  return readJson(file)
}

export type JsonRead = { state: "missing" } | { state: "ok"; value: any } | { state: "invalid"; error: string }

/**
 * Like `readJsonFile`, but it tells "there is no file" apart from "the file is
 * broken". Callers that WRITE must never treat a broken file as an empty one:
 * that is how a git conflict in rundev.json would be silently overwritten.
 */
export function readJsonStrict(file: string): JsonRead {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return { state: "missing" }
  }
  try {
    return { state: "ok", value: JSON.parse(text) }
  } catch (err) {
    const conflict = /^(<{7}|={7}|>{7})/m.test(text) ? " (it has git conflict markers)" : ""
    return { state: "invalid", error: `${(err as Error).message}${conflict}` }
  }
}

/** `app@ios` → `{ name: "app", target: "ios" }`. */
export function parseServiceRef(ref: string): { name: string; target?: string } {
  const at = ref.indexOf("@")
  return at < 0 ? { name: ref } : { name: ref.slice(0, at), target: ref.slice(at + 1) || undefined }
}

/**
 * What a bare `up` starts: the `default` list, where an entry may carry a target
 * (`"app@ios"`), split into service names and per-service targets.
 */
export function defaultPlan(loaded: Loaded): { names: string[]; targets: Record<string, string> } {
  const refs = loaded.manifest.default?.length ? loaded.manifest.default : Object.keys(loaded.manifest.services)
  const names: string[] = []
  const targets: Record<string, string> = {}
  for (const ref of refs) {
    const { name, target } = parseServiceRef(ref)
    if (!names.includes(name)) names.push(name)
    if (target) targets[name] = target
  }
  return { names, targets }
}

/** Walks up from `startDir` looking for the manifest. */
export function findManifest(startDir: string): Loaded | null {
  let dir = path.resolve(startDir)
  for (let i = 0; i < 8; i++) {
    const file = path.join(dir, MANIFEST_REL)
    if (fs.existsSync(file)) return load(dir, file)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Machine overrides are a PATCH, not a replacement: a `targets` entry in
 * `rundev.local.json` must not drop the `requires`, `check` or `launch` the
 * committed manifest declares for that same target.
 */
function mergeService(base: Service | undefined, patch: Record<string, any>): Service {
  const merged: Service = { ...(base ?? {}), ...patch } as Service
  if (base?.targets || patch.targets) {
    const targets: Record<string, Target> = { ...(base?.targets ?? {}) }
    for (const [name, targetPatch] of Object.entries<any>(patch.targets ?? {})) {
      targets[name] = { ...(targets[name] ?? {}), ...(targetPatch ?? {}) }
    }
    merged.targets = targets
  }
  return merged
}

/** The manifest a machine actually runs: the committed file plus the local patch. */
export function mergeLocal(manifest: Manifest, local: any): Manifest {
  const merged: Manifest = { ...manifest, services: { ...(manifest.services ?? {}) } }
  if (!local || typeof local !== "object") return merged
  if (Array.isArray(local.default)) merged.default = local.default
  for (const [name, patch] of Object.entries<any>(local.services ?? {})) {
    merged.services[name] = mergeService(merged.services[name], patch ?? {})
  }
  return merged
}

/** What a write changed, so the caller can report it (and the agent can confirm it). */
export interface ManifestDiff {
  added: string[]
  changed: string[]
  removed: string[]
  missing: string[]
  defaultChanged: boolean
}

export function diffManifest(
  before: any,
  after: Manifest,
  removed: string[] = [],
  missing: string[] = [],
): ManifestDiff {
  const beforeServices = before?.services ?? {}
  const names = Object.keys(beforeServices)
  const afterNames = Object.keys(after.services)
  return {
    added: afterNames.filter((name) => !names.includes(name)),
    changed: afterNames.filter(
      (name) => names.includes(name) && JSON.stringify(beforeServices[name]) !== JSON.stringify(after.services[name]),
    ),
    removed,
    missing,
    defaultChanged: JSON.stringify(before?.default ?? null) !== JSON.stringify(after.default ?? null),
  }
}

/**
 * Applies a partial manifest to the committed one: `services` merge per service,
 * `targets` merge per target, `default` replaces when present. `remove` deletes
 * services and drops them from `default`.
 */
export function patchManifest(
  committed: any,
  patch: any,
  remove: string[] = [],
): { manifest: Manifest } & ManifestDiff {
  const base: Manifest = {
    ...(committed ?? {}),
    services: { ...(committed?.services ?? {}) },
  }
  const next = mergeLocal(base, patch ?? {})
  next.services = { ...(next.services ?? {}) }
  const removed: string[] = []
  const missing: string[] = []
  for (const name of remove) {
    if (next.services[name]) {
      delete next.services[name]
      removed.push(name)
    } else missing.push(name)
  }
  if (removed.length && Array.isArray(next.default)) {
    next.default = next.default.filter((ref) => parseServiceRef(ref).name in next.services)
  }
  return { manifest: next, ...diffManifest(base, next, removed, missing) }
}

export function load(root: string, file: string): Loaded {
  const main = readJsonStrict(file)
  const localFile = path.join(root, LOCAL_REL)
  const loc = readJsonStrict(localFile)
  const errors: string[] = []
  if (main.state === "invalid") errors.push(`${path.relative(root, file)}: ${main.error}`)
  if (loc.state === "invalid") errors.push(`${path.relative(root, localFile)}: ${loc.error}`)
  const raw = main.state === "ok" && main.value && typeof main.value === "object" ? main.value : { services: {} }
  const local = loc.state === "ok" ? loc.value : null
  const localApplied = Boolean(local && typeof local === "object")
  const manifest: Manifest = mergeLocal({ ...raw, services: { ...(raw.services ?? {}) } }, local)
  return { root, file, manifest, localApplied, ...(errors.length ? { parseError: errors.join("; ") } : {}) }
}

/** Services a bare `up` starts (names only; see `defaultPlan` for their targets). */
export function defaultSet(loaded: Loaded): string[] {
  return defaultPlan(loaded).names
}

/** Absolute service CWD (honours the repo-relative `cwd`). */
export function serviceCwd(loaded: Loaded, svc: Service): string {
  return svc.cwd ? path.resolve(loaded.root, svc.cwd) : loaded.root
}

/** Resolved, absolute compose files. */
export function composeFiles(loaded: Loaded, svc: Service): string[] {
  const files = Array.isArray(svc.file) ? svc.file : svc.file ? [svc.file] : []
  return files.map((f) => path.resolve(serviceCwd(loaded, svc), f))
}

const KINDS: Kind[] = ["compose", "process", "interactive", "browser", "emulator", "simulator"]
const MANIFEST_KEYS = ["$schema", "version", "default", "services"]
const SERVICE_KEYS = [
  "kind", "port", "cwd", "up", "check", "health", "file", "service", "avd", "device", "url", "profile",
  "targets", "defaultTarget", "stopMode", "waitMs", "requires",
]
const TARGET_KEYS = ["device", "envSection", "launch", "check", "requires"]

/** Edit distance, for "did you mean" on a misspelled field. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}

function unknownKeys(where: string, obj: any, valid: string[]): string[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return []
  return Object.keys(obj)
    .filter((key) => !valid.includes(key))
    .map((key) => {
      const near = valid.filter((v) => distance(key.toLowerCase(), v.toLowerCase()) <= 2)[0]
      return `${where}: unknown field "${key}"${near ? ` (did you mean "${near}"?)` : ` (valid: ${valid.filter((v) => v !== "$schema").join(", ")})`}`
    })
}

/**
 * Fields rundev does not know. They are ignored at run time, so an agent that
 * writes `dependsOn` believes it expressed an order that nothing enforces —
 * `apply` rejects the ones it would introduce; `doctor` lists the rest.
 */
export function lintManifest(manifest: any): string[] {
  const out = unknownKeys("manifest", manifest, MANIFEST_KEYS)
  for (const [name, svc] of Object.entries<any>(manifest?.services ?? {})) {
    out.push(...unknownKeys(name, svc, SERVICE_KEYS))
    for (const [tname, target] of Object.entries<any>(svc?.targets ?? {})) {
      out.push(...unknownKeys(`${name}@${tname}`, target, TARGET_KEYS))
    }
  }
  return out
}

/** Services a service needs first: its own `requires` plus its target's. */
export function requiresOf(svc: Service | undefined, target?: string): string[] {
  if (!svc) return []
  const t = svc.targets ? svc.targets[target ?? svc.defaultTarget ?? Object.keys(svc.targets)[0]] : undefined
  return [...new Set([...(svc.requires ?? []), ...(t?.requires ?? [])])]
}

/** Validates the manifest and returns readable problems. */
export function validate(loaded: Loaded): string[] {
  const problems: string[] = []
  const names = Object.keys(loaded.manifest.services)
  const kinds = KINDS
  if (loaded.parseError) problems.push(`invalid JSON — ${loaded.parseError}`)
  else if (names.length === 0) problems.push("no services declared")
  for (const name of names) {
    const svc = loaded.manifest.services[name]
    if (!svc.kind) problems.push(`${name}: missing "kind"`)
    else if (!kinds.includes(svc.kind)) problems.push(`${name}: unknown kind "${svc.kind}"`)
    if (svc.kind === "compose") {
      if (!svc.file) problems.push(`${name}: compose without "file"`)
      if (!svc.service) problems.push(`${name}: compose without "service"`)
      for (const f of composeFiles(loaded, svc)) {
        if (!fs.existsSync(f)) problems.push(`${name}: missing ${path.relative(loaded.root, f)}`)
      }
    }
    if (svc.kind === "process" && !svc.up) problems.push(`${name}: process without "up"`)
    if (svc.kind === "interactive" && !svc.up && !svc.targets) {
      problems.push(`${name}: interactive without "up" or "targets"`)
    }
    if (svc.kind === "browser" && !svc.url && !svc.port) problems.push(`${name}: browser without "url" or "port"`)
    if (svc.kind === "emulator" && !svc.avd) problems.push(`${name}: emulator without "avd"`)
    if (svc.kind === "simulator" && !svc.device) problems.push(`${name}: simulator without "device"`)
    if (svc.cwd && !fs.existsSync(serviceCwd(loaded, svc))) {
      problems.push(`${name}: cwd does not exist (${svc.cwd})`)
    }
    if (svc.port !== undefined && (!Number.isInteger(svc.port) || svc.port < 1 || svc.port > 65535)) {
      problems.push(`${name}: port ${svc.port} is not a TCP port`)
    }
    // Every target is validated, not only the default one: `app@ios` is a real
    // request even when the default is android.
    if (svc.defaultTarget && svc.targets && !svc.targets[svc.defaultTarget]) {
      problems.push(`${name}: defaultTarget "${svc.defaultTarget}" is not in targets`)
    }
    for (const dep of svc.requires ?? []) {
      if (!names.includes(dep)) problems.push(`${name}: requires "${dep}" which does not exist`)
      else if (dep === name) problems.push(`${name}: requires itself`)
    }
    for (const [tname, target] of Object.entries(svc.targets ?? {})) {
      if (svc.kind === "interactive" && !target.launch && !svc.up) {
        problems.push(`${name}@${tname}: interactive target without "launch" and the service has no "up"`)
      }
      for (const dep of target.requires ?? []) {
        if (!names.includes(dep)) problems.push(`${name}@${tname}: requires "${dep}" which does not exist`)
      }
    }
  }
  // `default` entries may carry a target: "app@ios".
  for (const ref of loaded.manifest.default ?? []) {
    const { name, target } = parseServiceRef(ref)
    const svc = loaded.manifest.services[name]
    if (!svc) problems.push(`default: "${ref}" which does not exist`)
    else if (target && !svc.targets?.[target]) {
      problems.push(`default: "${ref}": ${name} has no target "${target}" (declared: ${Object.keys(svc.targets ?? {}).join(", ") || "none"})`)
    }
  }
  // A cycle in `requires` would never come up: say it instead of looping.
  const visiting: string[] = []
  const done = new Set<string>()
  const walk = (name: string) => {
    if (done.has(name)) return
    const at = visiting.indexOf(name)
    if (at >= 0) {
      problems.push(`requires cycle: ${[...visiting.slice(at), name].join(" → ")}`)
      return
    }
    visiting.push(name)
    const svc = loaded.manifest.services[name]
    const targets = svc?.targets ? Object.keys(svc.targets) : [undefined]
    for (const tname of targets) for (const dep of requiresOf(svc, tname)) if (names.includes(dep)) walk(dep)
    visiting.pop()
    done.add(name)
  }
  for (const name of names) walk(name)
  return [...new Set(problems)]
}

/** Quotes a value for typing into a terminal. Returns null when unsafe. */
export function quoteForTyping(value: string): string | null {
  if (!value) return null
  if (!value.includes("'")) return `'${value}'`
  if (!/["$`\\!]/.test(value)) return `"${value}"`
  return null
}

// ─────────────────────────────────────────────────────────────── workspace

export const WORKSPACE_REL = "rundev.workspace.json"

export interface Workspace {
  name?: string
  /** Member repo directories, relative to the workspace root. */
  members: string[]
  /** `member → members it needs up first` (only used in workspace mode). */
  dependencies?: Record<string, string[]>
}

export interface LoadedWorkspace {
  root: string
  file: string
  workspace: Workspace
  /** The workspace file exists but is not valid JSON. */
  parseError?: string
}

/** Walks up from `startDir` looking for a `rundev.workspace.json`. */
export function findWorkspace(startDir: string): LoadedWorkspace | null {
  let dir = path.resolve(startDir)
  for (let i = 0; i < 8; i++) {
    const file = path.join(dir, WORKSPACE_REL)
    if (fs.existsSync(file)) {
      const read = readJsonStrict(file)
      const raw = read.state === "ok" && read.value && typeof read.value === "object" ? read.value : {}
      return {
        root: dir,
        file,
        workspace: {
          name: raw.name,
          members: Array.isArray(raw.members) ? raw.members : [],
          dependencies: raw.dependencies ?? {},
        },
        ...(read.state === "invalid" ? { parseError: read.error } : {}),
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export interface Member {
  /** The string listed in `members` (a directory name or a relative path). */
  name: string
  dir: string
  loaded: Loaded
}

/**
 * Workspace members that actually declare a manifest. A member must own its
 * manifest: `findManifest` walks UP, so a member without one would otherwise
 * silently pick up an ancestor's.
 */
export function workspaceMembers(ws: LoadedWorkspace): Member[] {
  const out: Member[] = []
  for (const member of ws.workspace.members) {
    const dir = path.resolve(ws.root, member)
    if (!fs.existsSync(path.join(dir, MANIFEST_REL))) continue
    const loaded = findManifest(dir)
    if (loaded && path.resolve(loaded.root) === dir) out.push({ name: member, dir, loaded })
  }
  return out
}

/** Which workspace member owns this manifest root (members may be written as paths). */
export function memberOf(ws: LoadedWorkspace, root: string): string | undefined {
  const target = path.resolve(root)
  return ws.workspace.members.find((member) => path.resolve(ws.root, member) === target)
}

/** Dependencies of a member, in the order they must come up (transitive, dependencies first). */
export function dependencyOrder(ws: LoadedWorkspace, member: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const visit = (name: string) => {
    if (seen.has(name)) return
    seen.add(name)
    for (const dep of ws.workspace.dependencies?.[name] ?? []) visit(dep)
    if (name !== member) out.push(name)
  }
  visit(member)
  return out
}

/** Problems in `rundev.workspace.json` itself. */
export function validateWorkspace(ws: LoadedWorkspace): string[] {
  const problems: string[] = []
  if (ws.parseError) problems.push(`${WORKSPACE_REL}: invalid JSON — ${ws.parseError}`)
  const members = ws.workspace.members
  if (!ws.parseError && members.length === 0) problems.push(`${WORKSPACE_REL}: no members`)
  for (const member of members) {
    if (!fs.existsSync(path.join(path.resolve(ws.root, member), MANIFEST_REL))) {
      problems.push(`member "${member}" has no ${MANIFEST_REL}`)
    }
  }
  for (const [member, needs] of Object.entries(ws.workspace.dependencies ?? {})) {
    if (!members.includes(member)) problems.push(`dependencies: "${member}" is not a member`)
    for (const dep of needs ?? []) {
      if (!members.includes(dep)) problems.push(`dependencies: ${member} needs "${dep}", which is not a member`)
    }
  }
  const visiting: string[] = []
  const done = new Set<string>()
  const walk = (name: string) => {
    if (done.has(name)) return
    const at = visiting.indexOf(name)
    if (at >= 0) {
      problems.push(`dependencies cycle: ${[...visiting.slice(at), name].join(" → ")}`)
      return
    }
    visiting.push(name)
    for (const dep of ws.workspace.dependencies?.[name] ?? []) walk(dep)
    visiting.pop()
    done.add(name)
  }
  for (const member of members) walk(member)
  return [...new Set(problems)]
}

/** Member directories that contain a manifest (used by `init` at a parent dir). */
export function membersWithManifest(root: string): string[] {
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .filter((e) => fs.existsSync(path.join(root, e.name, MANIFEST_REL)))
    .map((e) => e.name)
    .sort()
}

/** Escapes a value for an AppleScript string. */
export function quoteForAppleScript(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}
