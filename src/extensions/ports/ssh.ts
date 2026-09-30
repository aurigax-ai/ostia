const VALUE_FLAGS = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''))
const NO_SESSION_FLAGS = new Set(['G', 'V', 'Q', 'O'])
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252})$|^\[?[0-9A-Fa-f:.%]{2,64}\]?$/

function hostOf(destination: string): string | null {
  let rest = destination
  if (rest.startsWith('ssh://')) {
    rest = rest.slice('ssh://'.length).replace(/\/.*$/, '')
    const at = rest.lastIndexOf('@')
    if (at >= 0) rest = rest.slice(at + 1)
    rest = rest.replace(/^(\[[^\]]*\]|[^:]*):\d+$/, '$1')
  } else {
    const at = rest.lastIndexOf('@')
    if (at >= 0) rest = rest.slice(at + 1)
  }
  return HOST.test(rest) ? rest : null
}

export function sshArgs(argv: readonly string[]): string[] {
  const at = argv.findIndex((a) => a.slice(a.lastIndexOf('/') + 1) === 'ssh')
  return argv.slice(at + 1).filter(Boolean)
}

export function sshTarget(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') return args[i + 1] !== undefined ? hostOf(args[i + 1]) : null
    if (!arg.startsWith('-') || arg === '-') return hostOf(arg)
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j]
      if (NO_SESSION_FLAGS.has(flag)) return null
      if (VALUE_FLAGS.has(flag)) {
        if (j === arg.length - 1) i++
        break
      }
    }
  }
  return null
}
