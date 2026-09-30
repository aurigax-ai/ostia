import {
  DEFAULT_PROMPT_SETTINGS,
  type PromptSettings,
  parsePromptSettings,
} from '../../shared/promptSettings'
import { MATCH_PINE_THEME, parseThemeChoice } from '../../shared/themeChoice'

export interface TerminalSettings {
  scrollSpeed: number
  scrollbackLines: number
  warnOnRiskyPaste: boolean
  minimumContrast: number
  prompt: PromptSettings
  clipboardKeys: ClipboardKeys
  theme: string
}

export const CLIPBOARD_KEYS = ['shift', 'smart'] as const
export type ClipboardKeys = (typeof CLIPBOARD_KEYS)[number]

export interface PaneSettings {
  dimInactive: boolean
  focusOnHover: boolean
  equalizeOnSplit: boolean
  hideTabClose: boolean
}

export const SCROLL_SPEED_MIN = 0.5
export const SCROLL_SPEED_MAX = 5
export const SCROLLBACK_MIN = 1000
export const SCROLLBACK_MAX = 100000
export const CONTRAST_MIN = 1
export const CONTRAST_MAX = 21

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  scrollSpeed: 1,
  scrollbackLines: 10000,
  warnOnRiskyPaste: true,
  minimumContrast: 1,
  prompt: DEFAULT_PROMPT_SETTINGS,
  clipboardKeys: 'shift',
  theme: MATCH_PINE_THEME,
}

export const DEFAULT_PANE_SETTINGS: PaneSettings = {
  dimInactive: true,
  focusOnHover: false,
  equalizeOnSplit: false,
  hideTabClose: false,
}

function clampTo(v: unknown, min: number, max: number, fallback: number, decimals: number): number {
  const n = typeof v === 'number' ? v : Number.NaN
  if (!Number.isFinite(n)) return fallback
  const scale = 10 ** decimals
  return Math.min(max, Math.max(min, Math.round(n * scale) / scale))
}

export const clampScrollSpeed = (v: unknown): number =>
  clampTo(v, SCROLL_SPEED_MIN, SCROLL_SPEED_MAX, DEFAULT_TERMINAL_SETTINGS.scrollSpeed, 1)

export const clampScrollback = (v: unknown): number =>
  clampTo(v, SCROLLBACK_MIN, SCROLLBACK_MAX, DEFAULT_TERMINAL_SETTINGS.scrollbackLines, 0)

export const clampContrast = (v: unknown): number =>
  clampTo(v, CONTRAST_MIN, CONTRAST_MAX, DEFAULT_TERMINAL_SETTINGS.minimumContrast, 1)

function pickBooleans<T extends object>(base: T, raw: Record<string, unknown>): T {
  const out = { ...base }
  for (const key of Object.keys(base) as (keyof T & string)[]) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key] as T[keyof T & string]
  }
  return out
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseTerminalSettings(raw: unknown): TerminalSettings {
  const source = isRecord(raw) ? raw : {}
  return {
    ...pickBooleans(DEFAULT_TERMINAL_SETTINGS, source),
    scrollSpeed: clampScrollSpeed(source.scrollSpeed),
    scrollbackLines: clampScrollback(source.scrollbackLines),
    minimumContrast: clampContrast(source.minimumContrast),
    prompt: parsePromptSettings(source.prompt),
    clipboardKeys: CLIPBOARD_KEYS.includes(source.clipboardKeys as ClipboardKeys)
      ? (source.clipboardKeys as ClipboardKeys)
      : DEFAULT_TERMINAL_SETTINGS.clipboardKeys,
    theme: parseThemeChoice(source.theme),
  }
}

export function parsePaneSettings(raw: unknown): PaneSettings {
  return pickBooleans(DEFAULT_PANE_SETTINGS, isRecord(raw) ? raw : {})
}

const isNewline = (code: number): boolean => code === 10 || code === 13
const isTab = (code: number): boolean => code === 9
const isUnsafeControl = (code: number): boolean =>
  (code < 32 && !isNewline(code) && !isTab(code)) || code === 127

export function isRiskyPaste(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (isNewline(code) || isUnsafeControl(code)) return true
  }
  return false
}

const PREVIEW_LIMIT = 2000
const ESC = 27

export function pastePreview(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === ESC) out += '␛'
    else if (isUnsafeControl(code)) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += text[i]
  }
  return out.length > PREVIEW_LIMIT ? `${out.slice(0, PREVIEW_LIMIT)}…` : out
}
