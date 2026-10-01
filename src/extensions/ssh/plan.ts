import { quoteArgv } from '../../shared/shellQuote'
import { ALIAS_PATTERN } from './hosts'

export const MAX_HOPS = 8

export interface ConnectPlan {
  destination: string
  jump: string[]
  port?: number
  argv: string[]
  command: string
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
  const ssh = ['ssh']
  if (jump) ssh.push('-J', jump.join(','))
  if (port !== null) ssh.push('-p', String(port))
  ssh.push('--', destination)
  const plan: ConnectPlan = { destination, jump: jump ?? [], argv: ssh, command: quoteArgv(ssh) }
  if (port !== null) plan.port = port
  return plan
}
