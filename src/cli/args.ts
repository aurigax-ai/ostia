import { Command, CommanderError, Option } from 'commander'

export type FlagProblem = 'unknown' | 'missing-value'

export class FlagError extends Error {
  constructor(
    readonly problem: FlagProblem,
    readonly flag: string,
  ) {
    super(problem === 'unknown' ? `unknown flag ${flag}` : `${flag} needs a value`)
  }
}

export interface FlagSpec<V extends string, L extends string, B extends string> {
  values?: Record<V, string>
  lists?: Record<L, string>
  booleans?: Record<B, string>
  unknown?: 'refuse' | 'keep'
}

export interface ParsedArgs<V extends string, L extends string, B extends string> {
  positional: string[]
  values: Partial<Record<V, string>>
  lists: Record<L, string[]>
  booleans: Record<B, boolean>
}

const TERMINATOR = '--'
const MISSING_VALUE = 'commander.optionMissingArgument'

function declare<K extends string>(
  command: Command,
  flags: Record<K, string> | undefined,
  build: (flags: string) => Option,
): [K, Option][] {
  return (Object.entries(flags ?? {}) as [K, string][]).map(([key, text]) => {
    const option = build(text)
    command.addOption(option)
    return [key, option]
  })
}

function append(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function writtenFlag(option: Option): string {
  return option.long ?? option.short ?? option.flags
}

function withoutTerminator(unknown: string[]): string[] {
  const at = unknown.indexOf(TERMINATOR)
  return at < 0 ? unknown : [...unknown.slice(0, at), ...unknown.slice(at + 1)]
}

export function parseArgs<
  V extends string = never,
  L extends string = never,
  B extends string = never,
>(argv: readonly string[], spec: FlagSpec<V, L, B>): ParsedArgs<V, L, B> {
  const command = new Command().exitOverride().configureOutput({ outputError: () => {} })
  const values = declare(command, spec.values, (flags) => new Option(`${flags} <value>`))
  const lists = declare(command, spec.lists, (flags) =>
    new Option(`${flags} <value>`).argParser(append).default([]),
  )
  const booleans = declare(command, spec.booleans, (flags) => new Option(flags))

  let split: { operands: string[]; unknown: string[] }
  try {
    split = command.parseOptions([...argv])
  } catch (err) {
    if (!(err instanceof CommanderError) || err.code !== MISSING_VALUE) throw err
    const option = command.options.find((o) => err.message.includes(`'${o.flags}'`))
    throw new FlagError('missing-value', option ? writtenFlag(option) : err.message)
  }
  if (split.unknown.length > 0 && spec.unknown !== 'keep') {
    throw new FlagError('unknown', split.unknown[0])
  }

  const read = (option: Option): unknown => command.getOptionValue(option.attributeName())
  return {
    positional: [...split.operands, ...withoutTerminator(split.unknown)],
    values: Object.fromEntries(values.map(([key, option]) => [key, read(option)])) as Partial<
      Record<V, string>
    >,
    lists: Object.fromEntries(lists.map(([key, option]) => [key, read(option)])) as Record<
      L,
      string[]
    >,
    booleans: Object.fromEntries(
      booleans.map(([key, option]) => [key, read(option) === true]),
    ) as Record<B, boolean>,
  }
}
