import { homedir } from 'node:os'
import { join } from 'node:path'

export interface CliArgs {
  argv: string[]
  stdin?: string
}

export function cliArgs(args: unknown): CliArgs | null {
  if (typeof args !== 'object' || args === null) return null
  const argv = (args as { argv?: unknown }).argv
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string')) return null
  const stdin = (args as { stdin?: unknown }).stdin
  return typeof stdin === 'string' ? { argv, stdin } : { argv }
}

export function namedArgs(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}

export function parseFlags(
  argv: string[],
  valueFlags: string[],
  boolFlags: string[] = [],
): { flags: Record<string, string>; bools: Set<string>; rest: string[] } {
  const flags: Record<string, string> = {}
  const bools = new Set<string>()
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const name = arg.startsWith('--') ? arg.slice(2) : ''
    if (valueFlags.includes(name) && i + 1 < argv.length) {
      flags[name] = argv[++i]
    } else if (boolFlags.includes(name)) {
      bools.add(name)
    } else {
      rest.push(arg)
    }
  }
  return { flags, bools, rest }
}

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}
