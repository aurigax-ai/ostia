import { isAbsolute, join } from 'node:path'
import {
  AGENT_OFFER_LABEL_MAX,
  AGENT_OFFER_TEXT_MAX,
  AGENT_PROMPT_MAX,
} from '../../shared/extensions'
import { MANAGER_AGENT_NAME } from '../../shared/managerSettings'
import { ReportLimiter } from '../diagnostics/rendererReports'

export const AGENT_TASKS_PER_MINUTE = 6
const AGENT_TASK_WINDOW_MS = 60_000
export const REACHED_PANES_MAX = 256

export type AgentOfferDelivery = { delivered: false } | { delivered: true; paneId: string | null }

function controlCharacters(text: string, allowed: string): boolean {
  for (const ch of text) {
    if ((ch < ' ' || ch === '\x7f') && !allowed.includes(ch)) return true
  }
  return false
}

function oneLine(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string' || controlCharacters(raw, '')) return null
  const text = raw.trim()
  return text && text.length <= max ? text : null
}

export function offerText(raw: unknown): string | null {
  return oneLine(raw, AGENT_OFFER_TEXT_MAX)
}

export function offerLabel(raw: unknown): string | null {
  return oneLine(raw, AGENT_OFFER_LABEL_MAX)
}

export function agentPrompt(raw: unknown): string | null {
  if (typeof raw !== 'string' || controlCharacters(raw, '\n\t')) return null
  const prompt = raw.trim()
  return prompt && prompt.length <= AGENT_PROMPT_MAX ? prompt : null
}

export function agentName(raw: unknown): string | null {
  return typeof raw === 'string' && MANAGER_AGENT_NAME.test(raw) ? raw : null
}

export function workspaceIdOf(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 200 ? raw : null
}

export function agentTaskLimiter(now: () => number = Date.now): ReportLimiter {
  return new ReportLimiter(AGENT_TASKS_PER_MINUTE, AGENT_TASK_WINDOW_MS, now)
}

export function workspaceFolder(workDir: string | undefined, home: string): string | undefined {
  if (!workDir) return undefined
  if (workDir === '~') return home
  const expanded = workDir.startsWith('~/') ? join(home, workDir.slice(2)) : workDir
  return isAbsolute(expanded) ? expanded : undefined
}
