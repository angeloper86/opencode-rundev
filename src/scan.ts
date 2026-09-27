/**
 * scan.ts — deterministic inspection that feeds `init`.
 *
 * It never guesses silently: whatever it cannot determine is returned as a
 * `TODO` note for the user/agent to resolve.
 */

import fs from "node:fs"
import path from "node:path"
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

export function scan(root: string): ScanResult {
  const notes: string[] = []
  const services: Record<string, Service> = {}
  const signals: Record<string, unknown> = {}
  const defaults: string[] = []

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
      if (!port) notes.push(`compose/${name}: no pude leer el puerto del host → TODO`)
    }
    if (Object.keys(parsed).length === 0) notes.push(`no pude parsear los servicios de ${compose} → TODO`)
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
      ...(port ? { health: `http://localhost:${port}` } : {}),
    }
    defaults.push("app")
    if (!isVite && !port) notes.push("app: no encontré el puerto en .env → TODO")
    if (isVite) {
      services.browser = { kind: "browser", url: "http://localhost:5173", profile: ".opencode/.chrome-profile" }
      defaults.push("browser")
      notes.push("browser: agregar `.opencode/.chrome-profile/` al .gitignore")
    }
  }
  const deno = readJson(path.join(root, "deno.json")) ?? readJson(path.join(root, "deno.jsonc"))
  if (deno?.tasks?.dev && !services.app) {
    services.api = { kind: "process", up: "deno task dev", ...(envPort(root) ? { port: envPort(root) as number } : {}) }
    defaults.push("api")
    notes.push("api: confirmá el puerto → TODO")
  }

  // ── flutter
  if (fs.existsSync(path.join(root, "pubspec.yaml"))) {
    const envFile = path.join(root, ".env")
    const sections = fs.existsSync(envFile)
      ? [...fs.readFileSync(envFile, "utf8").matchAll(/^#\s*([A-Z][A-Z0-9_]*)\s*$/gm)].map((m) => m[1])
      : []
    signals.flutter = { envSections: sections }
    if (sections.length) {
      notes.push(`flutter: el .env ya trae secciones (${sections.join(", ")}); las uso como envSection de cada target`)
    } else {
      notes.push("flutter: si cambiás de plataforma con el .env, conviene declarar secciones → TODO")
    }
    services.app = {
      kind: "interactive",
      up: "flutter run",
      defaultTarget: "android",
      targets: {
        android: { device: "TODO (emulator-5554)", ...(sections.includes("ANDROID") ? { envSection: "ANDROID" } : {}) },
        ios: { device: "TODO (iPhone 16)", ...(sections.includes("IOS") ? { envSection: "IOS" } : {}) },
        web: { device: "chrome" },
      },
    }
    defaults.unshift("app")
    notes.push("flutter: completá el AVD/simulador real de esta máquina en rundev.local.json (o dejamelo a mí)")
  }

  // ── .vscode/launch.json (the historical truth)
  const launch = readJson(path.join(root, ".vscode", "launch.json"))
  if (launch?.configurations) {
    const urls = (launch.configurations as any[]).map((c) => c?.url).filter(Boolean)
    if (urls.length) signals.vscodeChromeUrl = urls
  }

  const draft: Manifest = {
    version: 1,
    default: [...new Set(defaults)],
    services,
  }
  if (Object.keys(services).length === 0) notes.push("no detecté ningún servicio: escribí el manifiesto a mano")
  return { draft, notes, signals }
}
