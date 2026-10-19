import { rmSync } from 'node:fs'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'

const paths = new Map<string, string>()
const written = new Map<string, number>()
let sequence = 0

export function registerMailFlag(externalId: string, path: string): void {
  paths.set(externalId, path)
  written.delete(externalId)
}

export function forgetMailFlag(externalId: string): void {
  const path = paths.get(externalId)
  if (path) rmSync(path, { force: true })
  paths.delete(externalId)
  written.delete(externalId)
}

export function syncMailFlags(counts: ReadonlyMap<string, number>): void {
  for (const [externalId, path] of paths) {
    const count = counts.get(externalId) ?? 0
    if (written.get(externalId) === count) continue
    try {
      writeFileAtomic(path, `${count}:${++sequence}\n`, { mode: 0o600 })
      written.set(externalId, count)
    } catch {
      written.delete(externalId)
    }
  }
}
