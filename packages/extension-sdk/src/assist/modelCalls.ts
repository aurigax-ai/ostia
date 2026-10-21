import {
  APICallError,
  dynamicTool,
  type JSONSchema7,
  jsonSchema,
  RetryError,
  type ToolSet,
} from 'ai'
import type { ChatToolSpec } from '../contract/assist'
import { HttpError } from './endpoint'

export function chatToolSet(specs: ChatToolSpec[]): ToolSet {
  const tools: ToolSet = {}
  for (const spec of specs) {
    tools[spec.name] = dynamicTool({
      description: spec.description,
      inputSchema: jsonSchema(spec.inputSchema as JSONSchema7),
    })
  }
  return tools
}

export function statusOf(err: unknown): number | undefined {
  if (err instanceof HttpError) return err.status
  if (APICallError.isInstance(err)) return err.statusCode
  if (RetryError.isInstance(err)) return statusOf(err.lastError)
  return undefined
}

export function messageOf(err: unknown): string {
  if (RetryError.isInstance(err)) return messageOf(err.lastError)
  if (APICallError.isInstance(err)) {
    const body = err.responseBody?.trim()
    return err.statusCode ? `HTTP ${err.statusCode}: ${body || err.message}` : err.message
  }
  return err instanceof Error ? err.message : String(err)
}
