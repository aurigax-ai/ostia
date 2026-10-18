import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface KeptOwner {
  pid: number
  startedAt: number
}

export const CURRENT_OWNER: KeptOwner = {
  pid: process.pid,
  startedAt: Date.now() - Math.round(process.uptime() * 1000),
}

export function keptOwnerFile(dir: string, name: string): string {
  return join(dir, `${name}.owner.json`)
}

export function writeKeptOwner(file: string, owner: KeptOwner): void {
  const partial = `${file}.partial`
  writeFileSync(partial, JSON.stringify(owner), { mode: 0o600 })
  renameSync(partial, file)
}

function isPositiveInteger(raw: unknown): raw is number {
  return Number.isInteger(raw) && (raw as number) > 0
}

export function readKeptOwner(file: string): KeptOwner | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null
    if (!raw || !isPositiveInteger(raw.pid) || !isPositiveInteger(raw.startedAt)) return null
    return { pid: raw.pid, startedAt: raw.startedAt }
  } catch {
    return null
  }
}

export function sameOwner(a: KeptOwner | null, b: KeptOwner): boolean {
  return a !== null && a.pid === b.pid && a.startedAt === b.startedAt
}
