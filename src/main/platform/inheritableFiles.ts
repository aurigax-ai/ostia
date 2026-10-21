import type { StdioOptions } from 'node:child_process'
import { closeSync, openSync, readdirSync, readFileSync } from 'node:fs'

const O_CLOEXEC = 0o2000000
const FIRST_SHARED_FD = 3

type Stdio = 'ignore' | 'inherit' | 'pipe' | number

export function inheritableFds(platform: NodeJS.Platform = process.platform): number[] {
  if (platform !== 'linux') return []
  let names: string[]
  try {
    names = readdirSync('/proc/self/fd')
  } catch {
    return []
  }
  return names
    .map(Number)
    .filter((fd) => Number.isInteger(fd) && fd >= FIRST_SHARED_FD)
    .filter((fd) => {
      try {
        const flags = /^flags:\s*([0-7]+)/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))
        return flags !== null && (Number.parseInt(flags[1] as string, 8) & O_CLOEXEC) === 0
      } catch {
        return false
      }
    })
    .sort((a, b) => a - b)
}

export function withoutInheritedFiles(
  stdio: [Stdio, Stdio, Stdio],
  fds: readonly number[] = inheritableFds(),
): { stdio: StdioOptions; release: () => void } {
  if (fds.length === 0) return { stdio, release: () => {} }
  const devNull = openSync('/dev/null', 'r')
  const last = Math.max(...fds)
  const blocked = new Set(fds)
  const slots: Stdio[] = [...stdio]
  for (let fd = FIRST_SHARED_FD; fd <= last; fd++) slots.push(blocked.has(fd) ? devNull : 'ignore')
  return { stdio: slots, release: () => closeSync(devNull) }
}
