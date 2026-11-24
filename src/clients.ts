/**
 * clients.ts — which terminal hosts which OpenCode TUI.
 *
 * The engine runs in the OpenCode *server*; the person sits in a TUI *client*.
 * To open a panel next to the right terminal (and not in whatever window happens
 * to have the focus) the server needs to know which terminal that client lives
 * in. Each TUI registers itself here: its pid, its tty and the session it shows.
 *
 * Shared by `tui.tsx` (writes) and the server side (reads). Node only.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export interface ClientInfo {
  pid: number
  /** `/dev/ttys003`, when the client runs in a terminal. */
  tty?: string
  /** Directory the client was opened in. */
  dir: string
  /** Session the client is showing right now. */
  sessionID?: string
  ts: number
}

export function clientsDir(): string {
  return process.env.RUNDEV_CLIENTS_DIR || path.join(os.homedir(), ".cache", "opencode-rundev", "clients")
}

/** `ttys003` → `/dev/ttys003`; undefined when the process has no terminal. */
export function ttyOfPid(pid: number): string | undefined {
  try {
    const r = spawnSync("/bin/ps", ["-o", "tty=", "-p", String(pid)], { encoding: "utf8", timeout: 3_000 })
    const tty = String(r.stdout ?? "").trim()
    if (!tty || tty === "??" || tty === "?") return undefined
    return tty.startsWith("/dev/") ? tty : `/dev/${tty}`
  } catch {
    return undefined
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === "EPERM"
  }
}

export function registerClient(info: Omit<ClientInfo, "ts">): void {
  try {
    fs.mkdirSync(clientsDir(), { recursive: true })
    fs.writeFileSync(path.join(clientsDir(), `${info.pid}.json`), JSON.stringify({ ...info, ts: Date.now() }))
  } catch {
    /* a registry is a courtesy: the panel falls back to a directory match */
  }
}

export function unregisterClient(pid: number): void {
  try {
    fs.rmSync(path.join(clientsDir(), `${pid}.json`), { force: true })
  } catch {
    /* ignore */
  }
}

/** Live clients; entries of dead processes are pruned on the way. */
export function listClients(): ClientInfo[] {
  let names: string[] = []
  try {
    names = fs.readdirSync(clientsDir())
  } catch {
    return []
  }
  const out: ClientInfo[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const file = path.join(clientsDir(), name)
    try {
      const info = JSON.parse(fs.readFileSync(file, "utf8")) as ClientInfo
      if (Number.isInteger(info.pid) && pidAlive(info.pid)) out.push(info)
      else fs.rmSync(file, { force: true })
    } catch {
      /* half-written: next time */
    }
  }
  return out
}
