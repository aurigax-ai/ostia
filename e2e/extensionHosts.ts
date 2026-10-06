import { execFileSync } from 'node:child_process'
import type { ElectronApplication } from '@playwright/test'

const HOST_SCRIPT = /[/\\]extensions[/\\]([^/\\\s]+)[/\\]main\.js(\s|$)/

export function extensionHosts(app: ElectronApplication): string[] {
  const main = app.process().pid
  const out = execFileSync('ps', ['-ww', '-A', '-o', 'ppid=,command='], { encoding: 'utf8' })
  const ids = new Set<string>()
  for (const line of out.split('\n')) {
    const row = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!row || Number(row[1]) !== main) continue
    const ext = row[2].match(HOST_SCRIPT)
    if (ext) ids.add(ext[1])
  }
  return [...ids].sort()
}
