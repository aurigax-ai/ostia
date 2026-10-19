import { parseAgentStop } from '@aurigax-ai/ostia-extension-sdk/contract/agentStop'
import { oneLine, plainBlock } from './questions'

export const STATUS_MESSAGE_MAX = 280

export function closingLine(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined
  const first = plainBlock(text)
    .split('\n')
    .find((line) => line.trim())
  const line = first === undefined ? '' : oneLine(first)
  if (!line) return undefined
  return line.length > STATUS_MESSAGE_MAX ? `${line.slice(0, STATUS_MESSAGE_MAX - 1)}…` : line
}

export function closingFromStop(raw: string): string | undefined {
  return closingLine(parseAgentStop('claude', raw)?.message)
}
