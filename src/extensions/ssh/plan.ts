import { quoteArgv } from '../../shared/terminal/shellQuote'
import type { HelperBundle } from './helper'
import { ALIAS_PATTERN } from './hosts'
import { REMOTE_COMMAND } from './remote'

export const MAX_HOPS = 8

export interface ConnectPlan {
  destination: string
  jump: string[]
  port?: number
  argv: string[]
  command: string
  shellIntegration: boolean
  helperIntegration?: true
}

const USER_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/
const PORT_PATTERN = /^[1-9][0-9]{0,4}$/
const MAX_PORT = 65535

function portOf(text: string | undefined): number | null {
  if (text === undefined || !PORT_PATTERN.test(text)) return null
  const port = Number(text)
  return port <= MAX_PORT ? port : null
}

function isLogin(text: string): boolean {
  const at = text.lastIndexOf('@')
  if (at >= 0 && !USER_PATTERN.test(text.slice(0, at))) return false
  return ALIAS_PATTERN.test(text.slice(at + 1))
}

function isHop(text: string): boolean {
  const colon = text.lastIndexOf(':')
  if (colon < 0) return isLogin(text)
  return isLogin(text.slice(0, colon)) && portOf(text.slice(colon + 1)) !== null
}

function hopsOf(text: string | undefined): string[] | null {
  if (text === undefined) return null
  const hops = text.split(',')
  return hops.length <= MAX_HOPS && hops.every(isHop) ? hops : null
}

type Route = Pick<ConnectPlan, 'destination' | 'jump' | 'port'>

function sshArgv(route: Route, options: string[]): string[] {
  const ssh = ['ssh']
  if (route.jump.length > 0) ssh.push('-J', route.jump.join(','))
  if (route.port !== undefined) ssh.push('-p', String(route.port))
  ssh.push(...options, '--', route.destination)
  return ssh
}

export function planConnect(argv: string[]): ConnectPlan | null {
  const tokens = argv.flatMap((arg) => arg.split(/\s+/)).filter(Boolean)
  let jump: string[] | null = null
  let port: number | null = null
  let destination: string | null = null
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '-J') {
      if (jump) return null
      jump = hopsOf(tokens[++i])
      if (!jump) return null
    } else if (token === '-p') {
      if (port !== null) return null
      port = portOf(tokens[++i])
      if (port === null) return null
    } else if (destination !== null || !isLogin(token)) {
      return null
    } else {
      destination = token
    }
  }
  if (destination === null) return null
  const route: Route = { destination, jump: jump ?? [] }
  if (port !== null) route.port = port
  const ssh = sshArgv(route, [])
  return { ...route, argv: ssh, command: quoteArgv(ssh), shellIntegration: false }
}

export function withShellIntegration(plan: ConnectPlan, helper?: HelperBundle): ConnectPlan {
  const ssh = sshArgv(plan, ['-t'])
  const integrated: ConnectPlan = {
    ...plan,
    argv: [...ssh, helper ? helper.commands.session : REMOTE_COMMAND],
    command: quoteArgv(ssh),
    shellIntegration: true,
  }
  if (helper) integrated.helperIntegration = true
  return integrated
}

export type HelperCommandKind = 'run' | 'install' | 'remove'

export function planHelper(
  plan: ConnectPlan,
  kind: HelperCommandKind,
  helper: HelperBundle,
): string[] {
  return [...sshArgv(plan, ['-T']), helper.commands[kind]]
}

export function hostKey(plan: ConnectPlan): string {
  return plan.port === undefined ? plan.destination : `${plan.destination}:${plan.port}`
}
