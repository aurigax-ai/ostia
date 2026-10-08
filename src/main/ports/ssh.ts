export interface SshLogin {
  user?: string
  host: string
}

const VALUE_FLAGS = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''))
const NO_SESSION_FLAGS = new Set(['G', 'V', 'Q', 'O'])
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252})$|^\[?[0-9A-Fa-f:.%]{2,64}\]?$/
const USER = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/

function loginOf(destination: string, flagUser: string | null): SshLogin | null {
  let rest = destination
  let user: string | null = null
  if (rest.startsWith('ssh://')) {
    rest = rest.slice('ssh://'.length).replace(/\/.*$/, '')
    rest = rest.replace(/^(.*@)?(\[[^\]]*\]|[^:]*):\d+$/, '$1$2')
  }
  const at = rest.lastIndexOf('@')
  if (at >= 0) {
    user = rest.slice(0, at)
    rest = rest.slice(at + 1)
  }
  if (!HOST.test(rest)) return null
  const who = user || flagUser
  return who && USER.test(who) ? { user: who, host: rest } : { host: rest }
}

export function sshArgs(argv: readonly string[]): string[] {
  const at = argv.findIndex((a) => a.slice(a.lastIndexOf('/') + 1) === 'ssh')
  return argv.slice(at + 1).filter(Boolean)
}

export function sshLogin(args: readonly string[]): SshLogin | null {
  let flagUser: string | null = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') return args[i + 1] !== undefined ? loginOf(args[i + 1], flagUser) : null
    if (!arg.startsWith('-') || arg === '-') return loginOf(arg, flagUser)
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j]
      if (NO_SESSION_FLAGS.has(flag)) return null
      if (VALUE_FLAGS.has(flag)) {
        const attached = arg.slice(j + 1)
        const value = attached || args[i + 1]
        if (!attached) i++
        if (flag === 'l' && value !== undefined) flagUser = value
        break
      }
    }
  }
  return null
}

export function sshLabel(login: SshLogin): string {
  return login.user ? `${login.user}@${login.host}` : login.host
}
