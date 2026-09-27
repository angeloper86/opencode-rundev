/**
 * manifest.ts — lectura y validación del manifiesto `.opencode/rundev.json`.
 *
 * Un manifiesto declara SERVICIOS. Cada servicio declara, como mínimo, cómo se
 * comprueba (`check`) y cómo se baja (`down`/`stop`). Si no sabe verificarse ni
 * morir, no entra al manifiesto.
 */

import fs from "node:fs"
import path from "node:path"

export type Kind = "compose" | "process" | "interactive" | "browser"

export interface Target {
  /** Etiqueta del dispositivo (emulator-5554, iPhone 16, chrome…). */
  device?: string
  /** Sección del `.env` que este target requiere (ANDROID, IOS…). Solo se verifica. */
  envSection?: string
  /** Comando a lanzar en el panel (por defecto, `up` del servicio). */
  launch?: string
  /** Otros servicios que deben estar arriba. */
  requires?: string[]
}

export interface Service {
  kind: Kind
  /** Puerto TCP del servicio (verificación y reporte). */
  port?: number
  /** Directorio de trabajo relativo a la raíz del repo (p. ej. "../bankyto-api"). */
  cwd?: string
  /** Comando para servicios `process` / `interactive`. */
  up?: string
  /** Comando de verificación (exit 0 = arriba). */
  check?: string
  /** URL de salud (se prueba con curl si no hay `check`). */
  health?: string
  /** Docker compose: archivo(s) y servicio. */
  file?: string | string[]
  service?: string
  /** Navegador: URL y perfil. */
  url?: string
  profile?: string
  /** Interactive: variantes por dispositivo/plataforma. */
  targets?: Record<string, Target>
  defaultTarget?: string
  /** down: "wait" (por defecto) o "fire-and-forget" (emuladores). */
  stopMode?: "wait" | "fire-and-forget"
  /** Tiempo máximo de espera para arrancar/parar, en ms. */
  waitMs?: number
}

export interface Manifest {
  version?: number
  /** Servicios que `up` levanta cuando no se pide ninguno. */
  default?: string[]
  services: Record<string, Service>
}

export interface Loaded {
  root: string
  file: string
  manifest: Manifest
  /** Overrides de la máquina (`rundev.local.json`), ya aplicados. */
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

/** Busca el manifiesto hacia arriba desde `startDir`. */
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
  const manifest: Manifest = { services: {}, ...raw, services: { ...(raw.services ?? {}) } }
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

/** Servicios que un `up` sin argumentos levanta. */
export function defaultSet(loaded: Loaded): string[] {
  if (loaded.manifest.default?.length) return loaded.manifest.default
  return Object.keys(loaded.manifest.services)
}

/** CWD absoluto del servicio (respeta `cwd` relativo al repo). */
export function serviceCwd(loaded: Loaded, svc: Service): string {
  return svc.cwd ? path.resolve(loaded.root, svc.cwd) : loaded.root
}

/** Archivos compose resueltos y absolutos. */
export function composeFiles(loaded: Loaded, svc: Service): string[] {
  const files = Array.isArray(svc.file) ? svc.file : svc.file ? [svc.file] : []
  return files.map((f) => path.resolve(serviceCwd(loaded, svc), f))
}

/** Valida el manifiesto y devuelve problemas legibles. */
export function validate(loaded: Loaded): string[] {
  const problems: string[] = []
  const names = Object.keys(loaded.manifest.services)
  if (names.length === 0) problems.push("no hay servicios declarados")
  for (const name of names) {
    const svc = loaded.manifest.services[name]
    if (!svc.kind) problems.push(`${name}: falta "kind"`)
    if (svc.kind === "compose") {
      if (!svc.file) problems.push(`${name}: compose sin "file"`)
      if (!svc.service) problems.push(`${name}: compose sin "service"`)
      for (const f of composeFiles(loaded, svc)) {
        if (!fs.existsSync(f)) problems.push(`${name}: no existe ${path.relative(loaded.root, f)}`)
      }
    }
    if (svc.kind === "process" && !svc.up) problems.push(`${name}: process sin "up"`)
    if (svc.kind === "interactive" && !svc.up && !svc.targets) {
      problems.push(`${name}: interactive sin "up" ni "targets"`)
    }
    if (svc.kind === "browser" && !svc.url && !svc.port) problems.push(`${name}: browser sin "url" ni "port"`)
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

/** Cita un valor para tipearlo en una terminal. Devuelve null si no es seguro. */
export function quoteForTyping(value: string): string | null {
  if (!value) return null
  if (!value.includes("'")) return `'${value}'`
  if (!/["$`\\!]/.test(value)) return `"${value}"`
  return null
}

/** Escapa un valor para un string de AppleScript. */
export function quoteForAppleScript(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}
