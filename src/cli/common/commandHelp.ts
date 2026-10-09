import type { CommandDescriptor } from '../../shared/types'

const HELP_FLAGS = new Set(['--help', '-h'])

export function wantsHelp(arg: string | undefined): boolean {
  return arg !== undefined && HELP_FLAGS.has(arg)
}

export function commandHelp(descriptor: CommandDescriptor): string {
  const lines = [
    `${descriptor.id}: ${descriptor.title}`,
    '',
    `usage: ostia ${descriptor.id} [json-args]`,
  ]
  if (descriptor.argsSchema) {
    lines.push('', 'args (JSON):', JSON.stringify(descriptor.argsSchema, null, 2))
  } else {
    lines.push('', 'takes no arguments')
  }
  return lines.join('\n')
}
