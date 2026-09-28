/**
 * scan.ts — deterministic inspection that feeds `init`.
 *
 * It never guesses silently: whatever it cannot determine is returned as a
 * `TODO` note for the user/agent to resolve.
 */

import fs from "node:fs"
import path from "node:path"
import { ensureGitignored } from "./engine.ts"
import type { Manifest, Service } from "./manifest.ts"

export interface ScanResult {
  draft: Manifest
  notes: string[]
  signals: Record<string, unknown>
}

const COMPOSE_NAMES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "docker-compose.dev.yml",
  "docker-compose.dev.yaml",
]

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function parseCompose(text: string): Record<string, { image?: string; ports: string[] }> {
  const services: Record<string, { image?: string; ports: string[] }> = {}
  let inServices = false
  let current: string | null = null
  let inPorts = false
  for (const raw of text.split("\n")) {
    if (/^services:\s*(#.*)?$/.test(raw)) {
      inServices = true
      continue
    }
    if (inServices && /^\S/.test(raw) && !raw.startsWith("#")) break
    const svc = /^ {2}([A-Za-z0-9_.-]+):\s*(#.*)?$/.exec(raw)
    if (inServices && svc) {
      current = svc[1]
      services[current] = { ports: [] }
      inPorts = false
      continue
    }
    if (!current) continue
    const image = /^\s+image:\s*([^\s#]+)/.exec(raw)
    if (image) services[current].image = image[1]
    if (/^\s+ports:\s*(#.*)?$/.test(raw)) {
      inPorts = true
      continue
    }
    if (inPorts) {
      const item = /^\s+-\s*"?([^"\s]+)"?/.exec(raw)
      if (item) {
        const host = item[1].split(":")[0]
        if (/^\d+$/.test(host)) services[current].ports.push(host)
        continue
      }
      if (/^\s+\S/.test(raw)) inPorts = false
    }
  }
  return services
}

function envPort(root: string): number | null {
  const file = path.join(root, ".env")
  if (!fs.existsSync(file)) return null
  const text = fs.readFileSync(file, "utf8")
  const m = /^\s*(?:SERVER_PORT|PORT|APP_PORT)=(\d+)/m.exec(text)
  return m ? Number(m[1]) : null
}

/** Looks for a real health route in the source instead of guessing the root. */
function findHealthPath(dir: string, depth = 3): string | null {
  if (depth < 0) return null
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) {
      const hit = findHealthPath(abs, depth - 1)
      if (hit) return hit
      continue
    }
    if (!/\.(ts|js|mjs)$/.test(e.name)) continue
    try {
      const text = fs.readFileSync(abs, "utf8")
      if (/["'`]\/health["'`]/.test(text)) return "/health"
    } catch {
      /* ignore */
    }
  }
  return null
}

function healthUrl(root: string, port: number): string {
  for (const dir of ["src", "app", "server", "api", "lib"]) {
    const abs = path.join(root, dir)
    if (!fs.existsSync(abs)) continue
    const hit = findHealthPath(abs)
    if (hit) return `http://localhost:${port}${hit}`
  }
  return `http://localhost:${port}`
}

export function scan(root: string): ScanResult {
  const notes: string[] = []
  const services: Record<string, Service> = {}
  const signals: Record<string, unknown> = {}
  const defaults: string[] = []
  let draftDefault: string[] | null = null

  // ── docker compose
  const compose = COMPOSE_NAMES.find((f) => fs.existsSync(path.join(root, f)))
  if (compose) {
    const parsed = parseCompose(fs.readFileSync(path.join(root, compose), "utf8"))
    signals.compose = { file: compose, services: parsed }
    for (const [name, info] of Object.entries(parsed)) {
      const port = info.ports[0] ? Number(info.ports[0]) : undefined
      services[name] = {
        kind: "compose",
        file: compose,
        service: name,
        ...(port ? { port } : {}),
      }
      if (name.includes("db") || name.includes("postgres") || name.includes("mysql") || name.includes("redis")) {
        defaults.push(name)
      }
      if (!port) notes.push(`compose/${name}: could not read the host port → TODO`)
    }
    if (Object.keys(parsed).length === 0) notes.push(`could not parse services from ${compose} → TODO`)
  }

  // ── node / deno app server
  const pkg = readJson(path.join(root, "package.json"))
  if (pkg?.scripts?.dev) {
    const port = envPort(root)
    const isVite = Object.keys(pkg.dependencies ?? {}).some((d) => d === "vite") ||
      Object.keys(pkg.devDependencies ?? {}).some((d) => d === "vite")
    services.app = {
      kind: "process",
      up: isVite ? "yarn dev -- --port 5173 --strictPort" : "yarn dev",
      ...(isVite ? { port: 5173 } : port ? { port } : {}),
      ...(port ? { health: healthUrl(root, port) } : {}),
    }
    defaults.push("app")
    notes.push(
      `service "app" comes from package.json's dev script — rename it if you like: "api", "backend", "front", "web"…`,
    )
    if (!isVite && !port) notes.push("app: could not find the port in .env → TODO")
    if (isVite) {
      services.browser = { kind: "browser", url: "http://localhost:5173", profile: ".opencode/.chrome-profile" }
      defaults.push("browser")
      if (ensureGitignored(root, ".opencode/.chrome-profile/")) {
        notes.push("browser: added `.opencode/.chrome-profile/` to .gitignore")
      }
    }
  }
  const deno = readJson(path.join(root, "deno.json")) ?? readJson(path.join(root, "deno.jsonc"))
  if (deno?.tasks?.dev && !services.app) {
    services.api = { kind: "process", up: "deno task dev", ...(envPort(root) ? { port: envPort(root) as number } : {}) }
    defaults.push("api")
    notes.push("api: confirm the port → TODO")
  }

  // ── flutter
  if (fs.existsSync(path.join(root, "pubspec.yaml"))) {
    const hasAndroid = fs.existsSync(path.join(root, "android"))
    const hasIos = fs.existsSync(path.join(root, "ios"))
    const envFile = path.join(root, ".env")
    const sections = fs.existsSync(envFile)
      ? [...fs.readFileSync(envFile, "utf8").matchAll(/^#\s*([A-Z][A-Z0-9_]*)\s*$/gm)].map((m) => m[1])
      : []
    signals.flutter = { envSections: sections }
    if (sections.length) {
      notes.push(`flutter: .env already has sections (${sections.join(", ")}); using them as envSection per target`)
    } else {
      notes.push("flutter: if you switch platform via .env, declare sections → TODO")
    }
    services.app = {
      kind: "interactive",
      up: "flutter run",
      defaultTarget: "android",
      targets: {
        android: {
          device: "emulator",
          ...(hasAndroid ? { requires: ["emulator"] } : {}),
          ...(sections.includes("ANDROID") ? { envSection: "ANDROID" } : {}),
        },
        ios: {
          device: "simulator",
          ...(hasIos ? { requires: ["simulator"] } : {}),
          ...(sections.includes("IOS") ? { envSection: "IOS" } : {}),
        },
        web: { device: "chrome" },
      },
    }
    if (hasAndroid) {
      services.emulator = { kind: "emulator", avd: "TODO (machine-specific: see rundev.local.json)", waitMs: 180_000 }
    }
    if (hasIos) {
      services.simulator = { kind: "simulator", device: "TODO (machine-specific: see rundev.local.json)", waitMs: 90_000 }
    }
    defaults.unshift("app")
    draftDefault = ["app"] // `app` pulls its device (emulator/simulator) through `requires`
  }

  // ── .vscode/launch.json (the historical truth)
  const launch = readJson(path.join(root, ".vscode", "launch.json"))
  if (launch?.configurations) {
    const urls = (launch.configurations as any[]).map((c) => c?.url).filter(Boolean)
    if (urls.length) signals.vscodeChromeUrl = urls
  }

  const draft: Manifest = {
    version: 1,
    // default = everything detected; trim it by hand if a service is optional
    default: draftDefault ?? [...new Set([...defaults, ...Object.keys(services)])],
    services,
  }
  if (Object.keys(services).length === 0) notes.push("no services detected: write the manifest by hand")
  return { draft, notes, signals }
}
