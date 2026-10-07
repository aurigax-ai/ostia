import { type ChordSpec, overlaps, parseChord } from './chordSpec'

export interface DesktopKeys {
  name: string
  chords: readonly string[]
}

const ARROWS = ['Left', 'Right', 'Up', 'Down'] as const

export const DESKTOP_CHORDS: ReadonlyMap<string, DesktopKeys> = new Map([
  [
    'gnome',
    {
      name: 'GNOME',
      chords: [
        'Super+A',
        'Super+S',
        'Super+V',
        'Super+M',
        'Super+N',
        'Super+L',
        'Super+H',
        'Super+Tab',
        'Super+Shift+Tab',
        'Super+Space',
        'Super+Shift+Space',
        'Super+PageUp',
        'Super+PageDown',
        'Super+Home',
        'Super+End',
        'Super+Shift+PageUp',
        'Super+Shift+PageDown',
        'Super+Shift+Home',
        'Super+Shift+End',
        'Super+1-9',
        ...ARROWS.map((arrow) => `Super+${arrow}`),
        ...ARROWS.map((arrow) => `Super+Shift+${arrow}`),
        ...ARROWS.map((arrow) => `Ctrl+Alt+${arrow}`),
        ...ARROWS.map((arrow) => `Ctrl+Shift+Alt+${arrow}`),
        'Ctrl+Alt+Delete',
        'Ctrl+Alt+Tab',
        'Ctrl+Shift+Alt+R',
      ],
    },
  ],
  [
    'kde',
    {
      name: 'KDE Plasma',
      chords: [
        'Ctrl+F1',
        'Ctrl+F2',
        'Ctrl+F3',
        'Ctrl+F4',
        'Super+D',
        'Super+E',
        'Super+L',
        'Super+V',
        'Super+W',
        'Super+PageUp',
        'Super+PageDown',
        'Super+1-9',
        ...ARROWS.map((arrow) => `Super+${arrow}`),
        'Ctrl+Alt+Delete',
      ],
    },
  ],
])

export function desktopsOf(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(':')
    .map((name) => name.trim())
    .filter(Boolean)
}

function takes(keys: DesktopKeys, spec: ChordSpec): boolean {
  return keys.chords.some((text) => {
    const taken = parseChord(text, false)
    return taken !== null && overlaps(taken, spec)
  })
}

export function desktopTaking(spec: ChordSpec, desktops: readonly string[]): string | null {
  for (const desktop of desktops) {
    const keys = DESKTOP_CHORDS.get(desktop.toLowerCase())
    if (keys && takes(keys, spec)) return keys.name
  }
  return null
}
