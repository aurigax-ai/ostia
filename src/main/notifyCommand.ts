import { spawn } from 'node:child_process'
import { splitArgs } from '../shared/argv'

export interface NotifyCommandValues {
  title: string
  body: string
  pane: string
}

export function expandNotifyCommand(
  template: string,
  values: NotifyCommandValues,
): string[] | null {
  const tokens = splitArgs(template)
  if (!tokens || tokens.length === 0) return null
  return tokens.map((t) =>
    t.replace(/\{(title|body|pane)\}/g, (_m, key: keyof NotifyCommandValues) => values[key]),
  )
}

export function runNotifyCommand(template: string, values: NotifyCommandValues): boolean {
  if (!template.trim()) return false
  const argv = expandNotifyCommand(template, values)
  if (!argv) return false
  try {
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', shell: false })
    child.once('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}
