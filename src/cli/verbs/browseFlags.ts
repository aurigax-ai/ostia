export interface BrowseCall {
  verb: string
  method: string
  params: Record<string, unknown>
  readsStdin?: boolean
}

export type BrowseParse = { ok: true; call: BrowseCall } | { ok: false; error: string }

interface FlagSpec {
  values?: Record<string, string>
  booleans?: Record<string, string>
}

interface ParsedFlags {
  positional: string[]
  values: Record<string, string>
  booleans: Set<string>
}

const NEGATIVE_NUMBER = /^-\d/

export function parseFlags(args: string[], spec: FlagSpec): ParsedFlags | string {
  const positional: string[] = []
  const values: Record<string, string> = {}
  const booleans = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('-') || arg === '-' || NEGATIVE_NUMBER.test(arg)) {
      positional.push(arg)
      continue
    }
    const valueKey = spec.values?.[arg]
    if (valueKey) {
      const value = args[i + 1]
      if (value === undefined) return `${arg} needs a value`
      values[valueKey] = value
      i++
      continue
    }
    const boolKey = spec.booleans?.[arg]
    if (boolKey) {
      booleans.add(boolKey)
      continue
    }
    return `unknown flag ${arg}`
  }
  return { positional, values, booleans }
}

export function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

export function ok(
  verb: string,
  method: string,
  params: Record<string, unknown> = {},
): BrowseParse {
  return { ok: true, call: { verb, method, params } }
}

export function usage(text: string): BrowseParse {
  return { ok: false, error: `usage: ostia browse ${text}` }
}

export type Parser = (args: string[], cwd: string) => BrowseParse

export function targetVerb(verb: string, method = verb): Parser {
  return (args) => {
    const flags = parseFlags(args, {})
    if (typeof flags === 'string') return { ok: false, error: flags }
    const [target] = flags.positional
    return target ? ok(verb, `browse.${method}`, { target }) : usage(`${verb} <selector|@ref>`)
  }
}

export function plainVerb(verb: string, method = verb): Parser {
  return (args) => (args.length === 0 ? ok(verb, `browse.${method}`) : usage(verb))
}

export function keyVerb(verb: string): Parser {
  return (args) => (args[0] ? ok(verb, `browse.${verb}`, { key: args[0] }) : usage(`${verb} <key>`))
}

export function textVerb(verb: 'type' | 'fill'): Parser {
  return (args) => {
    const [target, ...text] = args
    if (!target || text.length === 0) return usage(`${verb} <selector|@ref> <text>`)
    return ok(verb, `browse.${verb}`, { target, text: text.join(' ') })
  }
}

export function bufferVerb(verb: 'console' | 'errors'): Parser {
  return (args) => {
    const flags = parseFlags(args, { booleans: { '--clear': 'clear' } })
    if (typeof flags === 'string' || flags.positional.length > 0) return usage(`${verb} [--clear]`)
    return ok(verb, `browse.${verb}`, { clear: flags.booleans.has('clear') })
  }
}
