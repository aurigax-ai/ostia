import { cliArgs } from '@aurigax-ai/ostia-extension-sdk'

export function jsonArg(args: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(cliArgs(args)?.argv[0] ?? '')
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}
