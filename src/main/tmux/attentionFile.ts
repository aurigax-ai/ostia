import { readFileSync, writeFileSync } from 'node:fs'

export const KEPT_ATTENTION_STATES = ['working', 'waiting', 'done', 'error'] as const

export type KeptAttentionState = (typeof KEPT_ATTENTION_STATES)[number]

export interface SavedAttention {
  state: KeptAttentionState
  message?: string
}

const ATTENTION_FILE_SUFFIX = '.state'
const MESSAGE_MAX = 300
const FILE_MAX_BYTES = 4096

export function attentionFileFor(tokenFile: string): string {
  return `${tokenFile}${ATTENTION_FILE_SUFFIX}`
}

export function isKeptAttentionState(value: unknown): value is KeptAttentionState {
  return typeof value === 'string' && (KEPT_ATTENTION_STATES as readonly string[]).includes(value)
}

export function parseSavedAttention(raw: string): SavedAttention | null {
  if (Buffer.byteLength(raw) > FILE_MAX_BYTES) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { state, message } = parsed as { state?: unknown; message?: unknown }
  if (!isKeptAttentionState(state)) return null
  const text = typeof message === 'string' ? message.trim().slice(0, MESSAGE_MAX) : ''
  return text ? { state, message: text } : { state }
}

export function writeSavedAttention(file: string, attention: SavedAttention | null): void {
  writeFileSync(file, attention ? JSON.stringify(attention) : '', { mode: 0o600 })
}

export function readSavedAttention(file: string): SavedAttention | null {
  try {
    return parseSavedAttention(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
