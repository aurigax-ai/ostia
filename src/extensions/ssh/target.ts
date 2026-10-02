import type { ToolRun } from '../sdk'

export const RESOLVE_ERROR_MAX = 240

export interface SshTarget {
  alias: string
  user?: string
  hostname?: string
  port?: number
  jump: string[]
  proxyCommand: boolean
  remoteCommand: boolean
}

export type RunSsh = (args: string[]) => Promise<ToolRun>

export type Resolved =
  | { ok: true; target: SshTarget }
  | { ok: false; error: 'ssh-missing' }
  | { ok: false; error: 'resolve-failed'; reason: string | null }

const UNSET = 'none'
const DEFAULT_SESSION = 'default'

function configValues(output: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const space = line.indexOf(' ')
    if (space <= 0) continue
    const key = line.slice(0, space)
    if (!values.has(key)) values.set(key, line.slice(space + 1).trim())
  }
  return values
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== '' && value !== UNSET
}

function hasOtherSession(value: string | undefined): boolean {
  return value !== undefined && value !== DEFAULT_SESSION
}

export function parseTarget(alias: string, output: string): SshTarget {
  const values = configValues(output)
  const jump = values.get('proxyjump')
  const target: SshTarget = {
    alias,
    jump: isSet(jump) ? jump.split(',').filter(Boolean) : [],
    proxyCommand: isSet(values.get('proxycommand')),
    remoteCommand: isSet(values.get('remotecommand')) || hasOtherSession(values.get('sessiontype')),
  }
  const user = values.get('user')
  if (isSet(user)) target.user = user
  const hostname = values.get('hostname')
  if (isSet(hostname)) target.hostname = hostname
  const port = Number(values.get('port'))
  if (Number.isInteger(port) && port > 0 && port <= 65535) target.port = port
  return target
}

function firstLine(text: string): string | null {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean)
  return line ? line.slice(0, RESOLVE_ERROR_MAX) : null
}

export async function resolveTarget(destination: string, run: RunSsh): Promise<Resolved> {
  const result = await run(['-G', '--', destination])
  if (result.missing) return { ok: false, error: 'ssh-missing' }
  if (result.timedOut) return { ok: false, error: 'resolve-failed', reason: null }
  if (result.code !== 0) {
    return { ok: false, error: 'resolve-failed', reason: firstLine(result.stderr) }
  }
  const alias = destination.slice(destination.lastIndexOf('@') + 1)
  return { ok: true, target: parseTarget(alias, result.stdout) }
}
