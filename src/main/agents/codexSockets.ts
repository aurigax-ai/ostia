import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { privateRunDir, socketPath } from '../platform/privateTmp'

const sockets = new Map<string, string>()

export function codexSocketDir(): string {
  return privateRunDir('codex')
}

export function codexSocketPath(): string {
  return socketPath(codexSocketDir(), `${randomUUID()}.sock`)
}

export function registerCodexSocket(externalId: string, path: string): void {
  sockets.set(externalId, path)
}

export function codexSocketOf(externalId: string): string | undefined {
  return sockets.get(externalId)
}

function killServer(pidFile: string): void {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8'))
    if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
}

export function forgetCodexSocket(externalId: string): void {
  const path = sockets.get(externalId)
  sockets.delete(externalId)
  if (!path) return
  killServer(`${path}.pid`)
  rmSync(path, { force: true })
  rmSync(`${path}.pid`, { force: true })
}
