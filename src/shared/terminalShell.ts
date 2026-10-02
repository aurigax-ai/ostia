import { splitArgs } from './argv'

export const SHELL_SETTING_MAX_LENGTH = 1024

export function parseShellSetting(raw: unknown): string {
  return typeof raw === 'string' && raw.length <= SHELL_SETTING_MAX_LENGTH ? raw.trim() : ''
}

export function shellArgv(setting: unknown, fallback: string): [string, ...string[]] {
  const tokens = splitArgs(parseShellSetting(setting))
  if (!tokens || tokens.length === 0 || tokens.some((t) => t === '' || t.includes('\0'))) {
    return [fallback]
  }
  const [program, ...args] = tokens
  return [program, ...args]
}

export function shellName(program: string): string {
  return program.slice(Math.max(program.lastIndexOf('/'), program.lastIndexOf('\\')) + 1)
}
