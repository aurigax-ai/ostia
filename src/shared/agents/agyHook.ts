import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { resumeFromHookPayload } from './agentResume'

export const AGY_HOOK_EVENTS = ['PreInvocation'] as const

export type AgyHookEvent = (typeof AGY_HOOK_EVENTS)[number]

export function isAgyHookEvent(value: unknown): value is AgyHookEvent {
  return typeof value === 'string' && (AGY_HOOK_EVENTS as readonly string[]).includes(value)
}

export function agyTurnStart(raw: string): string | null {
  try {
    const payload: unknown = JSON.parse(raw)
    if (!isRecord(payload) || payload.invocationNum !== 0) return null
  } catch {
    return null
  }
  return resumeFromHookPayload(raw)
}
