export type SpecTemplate = 'filepaths' | 'folders'

export interface SpecSuggestion {
  name: string
  description?: string
}

export interface SpecArg {
  name?: string
  description?: string
  suggestions?: SpecSuggestion[]
  template?: SpecTemplate[]
  isOptional?: boolean
  isVariadic?: boolean
}

export interface SpecOption {
  names: string[]
  description?: string
  args?: SpecArg[]
  isPersistent?: boolean
  isRepeatable?: boolean
}

export interface SpecCommand {
  names: string[]
  description?: string
  subcommands?: SpecCommand[]
  options?: SpecOption[]
  args?: SpecArg[]
}

export const SPEC_COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/
export const SPEC_FILE_MAX_BYTES = 4 * 1024 * 1024

const MAX_DEPTH = 12
const MAX_NAME = 200
const MAX_DESCRIPTION = 400
const MAX_ITEMS = 20000

interface Budget {
  nodes: number
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function names(raw: unknown): string[] | Error {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) {
    return new Error('names must be a non-empty array')
  }
  const out: string[] = []
  for (const n of raw) {
    if (typeof n !== 'string' || n.length === 0 || n.length > MAX_NAME) {
      return new Error('each name must be a non-empty string')
    }
    out.push(n)
  }
  return out
}

function description(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw ? raw.slice(0, MAX_DESCRIPTION) : undefined
}

function list<T>(
  raw: unknown,
  parse: (item: unknown) => T | Error,
  budget: Budget,
): T[] | undefined | Error {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) return new Error('expected an array')
  const out: T[] = []
  for (const item of raw) {
    if (++budget.nodes > MAX_ITEMS) return new Error('spec is too large')
    const parsed = parse(item)
    if (parsed instanceof Error) return parsed
    out.push(parsed)
  }
  return out
}

function parseSuggestion(raw: unknown): SpecSuggestion | Error {
  if (!isRecord(raw) || typeof raw.name !== 'string' || !raw.name || raw.name.length > MAX_NAME) {
    return new Error('suggestion needs a name')
  }
  const desc = description(raw.description)
  return desc ? { name: raw.name, description: desc } : { name: raw.name }
}

function parseArg(raw: unknown, budget: Budget): SpecArg | Error {
  if (!isRecord(raw)) return new Error('arg must be an object')
  const arg: SpecArg = {}
  if (typeof raw.name === 'string' && raw.name) arg.name = raw.name.slice(0, MAX_NAME)
  const desc = description(raw.description)
  if (desc) arg.description = desc
  const suggestions = list(raw.suggestions, parseSuggestion, budget)
  if (suggestions instanceof Error) return suggestions
  if (suggestions?.length) arg.suggestions = suggestions
  if (raw.template !== undefined) {
    if (!Array.isArray(raw.template)) return new Error('template must be an array')
    const template = raw.template.filter(
      (t): t is SpecTemplate => t === 'filepaths' || t === 'folders',
    )
    if (template.length) arg.template = template
  }
  if (raw.isOptional === true) arg.isOptional = true
  if (raw.isVariadic === true) arg.isVariadic = true
  return arg
}

function parseOption(raw: unknown, budget: Budget): SpecOption | Error {
  if (!isRecord(raw)) return new Error('option must be an object')
  const optionNames = names(raw.names)
  if (optionNames instanceof Error) return optionNames
  const option: SpecOption = { names: optionNames }
  const desc = description(raw.description)
  if (desc) option.description = desc
  const args = list(raw.args, (a) => parseArg(a, budget), budget)
  if (args instanceof Error) return args
  if (args?.length) option.args = args
  if (raw.isPersistent === true) option.isPersistent = true
  if (raw.isRepeatable === true) option.isRepeatable = true
  return option
}

function parseCommand(raw: unknown, depth: number, budget: Budget): SpecCommand | Error {
  if (depth > MAX_DEPTH) return new Error('spec is nested too deeply')
  if (!isRecord(raw)) return new Error('command must be an object')
  const commandNames = names(raw.names)
  if (commandNames instanceof Error) return commandNames
  const command: SpecCommand = { names: commandNames }
  const desc = description(raw.description)
  if (desc) command.description = desc
  const subcommands = list(raw.subcommands, (c) => parseCommand(c, depth + 1, budget), budget)
  if (subcommands instanceof Error) return subcommands
  if (subcommands?.length) command.subcommands = subcommands
  const options = list(raw.options, (o) => parseOption(o, budget), budget)
  if (options instanceof Error) return options
  if (options?.length) command.options = options
  const args = list(raw.args, (a) => parseArg(a, budget), budget)
  if (args instanceof Error) return args
  if (args?.length) command.args = args
  return command
}

export function parseCompletionSpec(raw: unknown): SpecCommand | Error {
  return parseCommand(raw, 0, { nodes: 0 })
}
