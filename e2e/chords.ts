import { type ChordSpec, chordTexts, parseScopedChord } from '../src/shared/keyboard/chordSpec'
import { DEFAULT_CHORDS } from '../src/shared/keyboard/defaultChords'

export const isMac = process.platform === 'darwin'

function pressedChord(spec: ChordSpec): string {
  if (!/^([a-z0-9]|f\d+)$/.test(spec.key)) throw new Error(`no Playwright key for ${spec.key}`)
  const modifiers = [
    spec.ctrl ? 'Control' : null,
    spec.alt ? 'Alt' : null,
    spec.shift ? 'Shift' : null,
    spec.meta ? 'Meta' : null,
  ].filter((name) => name !== null)
  return [...modifiers, spec.key.length > 1 ? spec.key.toUpperCase() : spec.key].join('+')
}

export function defaultChord(id: keyof typeof DEFAULT_CHORDS, mac: boolean): string {
  const spec = chordTexts(DEFAULT_CHORDS[id][mac ? 0 : 1])
    .map((text) => parseScopedChord(text, mac))
    .find((parsed) => parsed !== null && !parsed.terminal)
  if (!spec) throw new Error(`no default chord for ${id}`)
  return pressedChord(spec)
}

export const chords = {
  newWorkspace: isMac ? 'Meta+n' : 'Control+Shift+N',
  palette: defaultChord('palette.toggle', isMac),
  find: isMac ? 'Meta+f' : 'Control+Shift+f',
  copy: isMac ? 'Meta+c' : 'Control+Shift+c',
  paste: isMac ? 'Meta+v' : 'Control+Shift+v',
  selectAll: 'ControlOrMeta+a',
  documentEnd: isMac ? 'Meta+ArrowDown' : 'Control+End',
  blockPrev: isMac ? 'Meta+ArrowUp' : 'Control+Shift+ArrowUp',
  blockNext: isMac ? 'Meta+ArrowDown' : 'Control+Shift+ArrowDown',
  history: isMac ? 'Meta+Shift+h' : 'Control+Shift+h',
  splitRight: isMac ? 'Meta+Alt+Backslash' : 'Control+Alt+Backslash',
  closePane: isMac ? 'Meta+w' : 'Control+Shift+w',
  openSettings: 'ControlOrMeta+,',
  firstWorkspace: isMac ? 'Meta+1' : 'Control+1',
  resumeAgent: 'ControlOrMeta+Shift+R',
  newTab: isMac ? 'Meta+t' : 'Control+Shift+T',
  nextTab: 'Control+Tab',
  previousTab: 'Control+Shift+Tab',
}
