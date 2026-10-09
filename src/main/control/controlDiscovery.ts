import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadJson, saveJson } from '../platform/jsonStore'
import { type EnvSource, appDataDir } from '../platform/userDirs'

interface ControlInfo {
  socket?: unknown
  pid?: unknown
}

export function controlInfoPath(env: EnvSource = process.env): string {
  return join(appDataDir(env), 'control.json')
}

export function writeControlInfo(path: string, socket: string, pid: number): void {
  try {
    saveJson(path, { socket, pid }, { secure: true })
  } catch (err) {
    console.error('[control] could not record the socket path for scripts', err)
  }
}

export function clearControlInfo(path: string, socket: string): void {
  if (loadJson<ControlInfo>(path, {}).socket !== socket) return
  try {
    rmSync(path, { force: true })
  } catch {}
}

export function readControlSocket(path: string): string | undefined {
  const socket = loadJson<ControlInfo>(path, {}).socket
  return typeof socket === 'string' && socket && existsSync(socket) ? socket : undefined
}
