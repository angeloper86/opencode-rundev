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
  /** Other services that must be up first. */
  requires?: string[]
}

export interface Service {
  kind: Kind
  /** Service TCP port (verification and reporting). */
  port?: number
  /** Working directory relative to the repo root (e.g. "../bankyto-api"). */
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

export function load(root: string, file: string): Loaded {
  const raw = readJson(file) ?? { services: {} }
  const manifest: Manifest = { ...raw, services: { ...(raw.services ?? {}) } }
  let localApplied = false
  const localFile = path.join(root, LOCAL_REL)
  const local = readJson(localFile)
  if (local && typeof local === "object") {
    localApplied = true
    if (Array.isArray(local.default)) manifest.default = local.default
    for (const [name, patch] of Object.entries<any>(local.services ?? {})) {
      manifest.services[name] = { ...(manifest.services[name] ?? {}), ...patch }
    }
  }
  return { root, file, manifest, localApplied }
}

/** Services a bare `up` starts. */
export function defaultSet(loaded: Loaded): string[] {
  if (loaded.manifest.default?.length) return loaded.manifest.default
  return Object.keys(loaded.manifest.services)
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

/** Validates the manifest and returns readable problems. */
export function validate(loaded: Loaded): string[] {
  const problems: string[] = []
  const names = Object.keys(loaded.manifest.services)
  if (names.length === 0) problems.push("no services declared")
  for (const name of names) {
    const svc = loaded.manifest.services[name]
    if (!svc.kind) problems.push(`${name}: missing "kind"`)
    if (svc.kind === "compose") {
      if (!svc.file) problems.push(`${name}: compose without "file"`)
      if (!svc.service) problems.push(`${name}: compose without "service"`)
      for (const f of composeFiles(loaded, svc)) {
        if (!fs.existsSync(f)) problems.push(`${name}: no existe ${path.relative(loaded.root, f)}`)
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
      problems.push(`${name}: cwd inexistente (${svc.cwd})`)
    }
    for (const dep of svc.targets?.[svc.defaultTarget ?? ""]?.requires ?? []) {
      if (!names.includes(dep)) problems.push(`${name}: requires "${dep}" no existe`)
    }
  }
  for (const dep of loaded.manifest.default ?? []) {
    if (!names.includes(dep)) problems.push(`default: "${dep}" no existe`)
  }
  return problems
}

/** Quotes a value for typing into a terminal. Returns null when unsafe. */
export function quoteForTyping(value: string): string | null {
  if (!value) return null
  if (!value.includes("'")) return `'${value}'`
  if (!/["$`\\!]/.test(value)) return `"${value}"`
  return null
}

/** Escapes a value for an AppleScript string. */
export function quoteForAppleScript(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}
