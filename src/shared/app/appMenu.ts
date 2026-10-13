import type { ChordSpec } from '../keyboard/chordSpec'

export interface AppMenuCommand {
  command: string
  label: string
  accelerator?: string
}

export type AppMenuEntry = AppMenuCommand | { separator: true }

export const APP_MENU_SECTIONS = ['file', 'view', 'go', 'help'] as const

export type AppMenuSection = (typeof APP_MENU_SECTIONS)[number]

export type AppMenuSpec = Record<AppMenuSection, { label: string; items: AppMenuEntry[] }>

const COMMAND_ID = /^[A-Za-z0-9][\w.-]{0,127}$/
const MAX_LABEL = 120
const MAX_ITEMS = 40
const ACCELERATOR = /^[\w+=,.\-[\]\\;'`/]{1,48}$/

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_LABEL
    ? value
    : null
}

function entryOf(raw: unknown): AppMenuEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const item = raw as Record<string, unknown>
  if (item.separator === true) return { separator: true }
  const label = text(item.label)
  if (typeof item.command !== 'string' || !COMMAND_ID.test(item.command) || !label) return null
  const entry: AppMenuCommand = { command: item.command, label }
  if (typeof item.accelerator === 'string' && ACCELERATOR.test(item.accelerator)) {
    entry.accelerator = item.accelerator
  }
  return entry
}

export function parseAppMenuSpec(raw: unknown): AppMenuSpec | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  const spec = {} as AppMenuSpec
  for (const section of APP_MENU_SECTIONS) {
    const value = source[section]
    if (typeof value !== 'object' || value === null) return null
    const { label, items } = value as { label?: unknown; items?: unknown }
    const title = text(label)
    if (!title || !Array.isArray(items) || items.length > MAX_ITEMS) return null
    const entries: AppMenuEntry[] = []
    for (const item of items) {
      const entry = entryOf(item)
      if (!entry) return null
      entries.push(entry)
    }
    spec[section] = { label: title, items: entries }
  }
  return spec
}

const ELECTRON_KEYS: Record<string, string> = {
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  space: 'Space',
  enter: 'Return',
  tab: 'Tab',
  escape: 'Esc',
  backspace: 'Backspace',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  insert: 'Insert',
  '+': 'Plus',
}

function electronKey(key: string): string | null {
  if (ELECTRON_KEYS[key]) return ELECTRON_KEYS[key]
  if (/^[a-z]$/.test(key)) return key.toUpperCase()
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return key.toUpperCase()
  if (/^[0-9=,.\-[\]\\;'`/]$/.test(key)) return key
  return null
}

export function electronAccelerator(spec: ChordSpec): string | null {
  const key = electronKey(spec.key)
  if (!key) return null
  const parts: string[] = []
  if (spec.ctrl) parts.push('Ctrl')
  if (spec.alt) parts.push('Alt')
  if (spec.shift) parts.push('Shift')
  if (spec.meta) parts.push('Cmd')
  parts.push(key)
  return parts.join('+')
}
