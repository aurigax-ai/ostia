export type KeyModifier = 'shift' | 'control' | 'alt' | 'meta'

export interface KeyCombo {
  keyCode: string
  modifiers: KeyModifier[]
  printable: boolean
}

const MODIFIER_NAMES: Record<string, KeyModifier> = {
  shift: 'shift',
  control: 'control',
  ctrl: 'control',
  alt: 'alt',
  option: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
}

const KEY_ALIASES: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  esc: 'Escape',
  escape: 'Escape',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  space: 'Space',
  ' ': 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
}

export function parseKeyCombo(combo: string): KeyCombo | null {
  if (!combo) return null
  const parts =
    combo === '+'
      ? ['+']
      : combo.endsWith('++')
        ? [...combo.slice(0, -2).split('+'), '+']
        : combo.split('+')
  const rawKey = parts.pop() ?? ''
  const modifiers: KeyModifier[] = []
  for (const part of parts) {
    const modifier = MODIFIER_NAMES[part.toLowerCase()]
    if (!modifier) return null
    if (!modifiers.includes(modifier)) modifiers.push(modifier)
  }
  if (!rawKey) return null
  const alias = KEY_ALIASES[rawKey.toLowerCase()]
  const keyCode = alias ?? rawKey
  const printable =
    [...keyCode].length === 1 && !modifiers.includes('control') && !modifiers.includes('meta')
  return { keyCode, modifiers, printable }
}

export function globToRegExp(pattern: string): RegExp {
  let source = ''
  for (const ch of pattern) {
    if (ch === '*') source += source.endsWith('.*') ? '' : '.*'
    else if (ch === '?') source += '.'
    else source += ch.replace(/[.+^${}()|[\]\\/]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

export function globMatches(pattern: string, url: string): boolean {
  return globToRegExp(pattern).test(url)
}

export type ScrollDirection = 'up' | 'down' | 'left' | 'right'

export const DEFAULT_SCROLL_PX = 300

export function scrollDelta(direction: ScrollDirection, px: number): { dx: number; dy: number } {
  switch (direction) {
    case 'up':
      return { dx: 0, dy: -px }
    case 'down':
      return { dx: 0, dy: px }
    case 'left':
      return { dx: -px, dy: 0 }
    case 'right':
      return { dx: px, dy: 0 }
  }
}

export function isScrollDirection(value: unknown): value is ScrollDirection {
  return value === 'up' || value === 'down' || value === 'left' || value === 'right'
}

export function statusMatches(filter: string, status: number | undefined): boolean {
  if (status === undefined) return false
  const range = /^(\d{3})-(\d{3})$/.exec(filter)
  if (range) return status >= Number(range[1]) && status <= Number(range[2])
  const klass = /^([1-5])xx$/i.exec(filter)
  if (klass) return Math.floor(status / 100) === Number(klass[1])
  return String(status) === filter
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const OPAQUE_SCHEME = /^(about|data|blob|mailto|javascript):/i
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i

export function normalizeUrl(raw: string): string {
  const url = raw.trim()
  if (SCHEME.test(url) || OPAQUE_SCHEME.test(url)) return url
  return `${LOCAL_HOST.test(url) ? 'http' : 'https'}://${url}`
}
