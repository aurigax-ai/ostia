import {
  type CoreChipId,
  type PromptSeparator,
  type PromptSettings,
  isCoreChipId,
  separatorText,
} from '../../shared/promptSettings'
import type { PromptContext, PromptContextRequest, PtySpawnOptions } from '../../shared/types'
import type { CommandBlock } from '../stores/blocksStore'

export type ChipTone = 'default' | 'ok' | 'warn' | 'error'

export interface ContributedChip {
  extId: string
  id: string
  text: string
  tooltip?: string
  tone?: ChipTone
  command?: string
}

export interface ContributedChipInfo {
  extId: string
  id: string
  title: string
}

export interface ChipValue {
  text: string
  tooltip?: string
  tone: ChipTone
}

export interface ResolvedChip extends ChipValue {
  id: string
  core: CoreChipId | null
  extension?: ContributedChip
}

export interface LastCommand {
  exitCode: number
  startedAt: number
  endedAt: number
}

export interface CoreChipInputs {
  cwd?: string
  context: PromptContext | null
  lastCommand: LastCommand | null
  now: Date
  locale: string
}

export const contributedChipId = (extId: string, id: string): string => `${extId}.${id}`

export function abbreviateHome(path: string, home: string | undefined): string {
  if (!home || home === '/') return path
  const trimmed = home.replace(/\/+$/, '')
  if (path === trimmed) return '~'
  if (path.startsWith(`${trimmed}/`)) return `~${path.slice(trimmed.length)}`
  return path
}

export function formatDuration(ms: number): string {
  const safe = Math.max(0, Math.round(ms))
  if (safe < 1000) return `${safe}ms`
  const seconds = safe / 1000
  if (seconds < 60) return `${Number(seconds.toFixed(1))}s`
  const whole = Math.floor(seconds)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = whole % 60
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${rest}s`
}

export function lastCommand(blocks: readonly CommandBlock[] | undefined): LastCommand | null {
  if (!blocks) return null
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block.exitCode !== null && block.endedAt !== null) {
      return { exitCode: block.exitCode, startedAt: block.startedAt, endedAt: block.endedAt }
    }
  }
  return null
}

const plain = (text: string | null | undefined, tooltip?: string): ChipValue | null =>
  text ? { text, tone: 'default', ...(tooltip ? { tooltip } : {}) } : null

export function coreChipValue(id: CoreChipId, inputs: CoreChipInputs): ChipValue | null {
  const { context, now, locale } = inputs
  switch (id) {
    case 'cwd':
      return inputs.cwd ? plain(abbreviateHome(inputs.cwd, context?.home), inputs.cwd) : null
    case 'user':
      return plain(context?.user)
    case 'host':
      return plain(context?.host)
    case 'virtualenv':
      return plain(context?.virtualEnv)
    case 'conda':
      return plain(context?.condaEnv)
    case 'node':
      return plain(context?.nodeVersion)
    case 'kube':
      return plain(context?.kubeContext)
    case 'date':
      return plain(
        now.toLocaleDateString(locale, {
          weekday: 'short',
          month: 'short',
          day: '2-digit',
          year: 'numeric',
        }),
      )
    case 'time12':
      return plain(
        now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: true }),
      )
    case 'time24':
      return plain(
        now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false }),
      )
    case 'exitCode': {
      const last = inputs.lastCommand
      if (!last) return null
      return { text: String(last.exitCode), tone: last.exitCode === 0 ? 'ok' : 'error' }
    }
    case 'duration': {
      const last = inputs.lastCommand
      return last ? plain(formatDuration(last.endedAt - last.startedAt)) : null
    }
  }
}

export function resolvePromptChips(
  order: readonly string[],
  inputs: CoreChipInputs,
  contributed: readonly ContributedChip[],
): ResolvedChip[] {
  const chips: ResolvedChip[] = []
  for (const id of order) {
    if (isCoreChipId(id)) {
      const value = coreChipValue(id, inputs)
      if (!value) continue
      chips.push({ id, core: id, ...value })
      continue
    }
    const extension = contributed.find((c) => contributedChipId(c.extId, c.id) === id)
    if (!extension?.text) continue
    chips.push({
      id,
      core: null,
      text: extension.text,
      tone: extension.tone ?? 'default',
      ...(extension.tooltip ? { tooltip: extension.tooltip } : {}),
      extension,
    })
  }
  return chips
}

export function contextRequest(order: readonly string[]): PromptContextRequest {
  return { node: order.includes('node'), kube: order.includes('kube') }
}

const CLOCK_CHIPS: readonly string[] = ['date', 'time12', 'time24']

export const needsClock = (order: readonly string[]): boolean =>
  order.some((id) => CLOCK_CHIPS.includes(id))

export function promptLine(chips: readonly ResolvedChip[], separator: PromptSeparator): string {
  const sep = separatorText(separator)
  return [...chips.map((c) => c.text), ...(sep ? [sep] : [])].join(' ')
}

export function moveChip(order: readonly string[], from: number, to: number): string[] {
  if (from === to || from < 0 || from >= order.length) return [...order]
  const next = [...order]
  const [chip] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(to, next.length)), 0, chip)
  return next
}

export const removeChip = (order: readonly string[], id: string): string[] =>
  order.filter((c) => c !== id)

export const addChip = (order: readonly string[], id: string): string[] =>
  order.includes(id) ? [...order] : [...order, id]

export function spawnPromptOption(settings: {
  behavior: { inputMode: string }
  terminal: { prompt: PromptSettings }
}): Pick<PtySpawnOptions, 'pinePrompt'> {
  const { prompt } = settings.terminal
  if (prompt.style !== 'pine' || settings.behavior.inputMode !== 'editor') return {}
  return { pinePrompt: prompt.separator }
}
