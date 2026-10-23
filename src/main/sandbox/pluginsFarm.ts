import { lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

const PLUGINS_DATA = 'data'

function listed(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function linkedTo(link: string, target: string): boolean {
  try {
    return lstatSync(link).isSymbolicLink() && readlinkSync(link) === target
  } catch {
    return false
  }
}

function link(at: string, target: string): void {
  if (linkedTo(at, target)) return
  rmSync(at, { recursive: true, force: true })
  symlinkSync(target, at)
}

export function ensurePluginsFarm(farm: string, data: string): void {
  mkdirSync(data, { recursive: true, mode: 0o700 })
  mkdirSync(farm, { recursive: true, mode: 0o700 })
  link(join(farm, PLUGINS_DATA), data)
}

export function linkPluginsFarm(farm: string, data: string, source: string): void {
  ensurePluginsFarm(farm, data)
  const wanted = new Set(listed(source).filter((name) => name !== PLUGINS_DATA))
  for (const name of listed(farm)) {
    if (name !== PLUGINS_DATA && !wanted.has(name)) {
      rmSync(join(farm, name), { recursive: true, force: true })
    }
  }
  for (const name of wanted) link(join(farm, name), join(source, name))
}
