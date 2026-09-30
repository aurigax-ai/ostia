import type { ITheme } from '@xterm/xterm'

export type TerminalPalette = ITheme

const ONE_DARK_VIVID: TerminalPalette = {
  background: '#282c34',
  foreground: '#d7dae0',
  cursor: '#61afef',
  cursorAccent: '#282c34',
  selectionBackground: 'rgba(97, 175, 239, 0.25)',
  black: '#3a4150',
  red: '#ef596f',
  green: '#89ca78',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#d55fde',
  cyan: '#56b6c2',
  white: '#d7dae0',
  brightBlack: '#636d83',
  brightRed: '#ef596f',
  brightGreen: '#89ca78',
  brightYellow: '#e5c07b',
  brightBlue: '#61afef',
  brightMagenta: '#d55fde',
  brightCyan: '#56b6c2',
  brightWhite: '#ffffff',
}

const ADEBERRY: TerminalPalette = {
  background: '#1d2022',
  foreground: '#d5dde3',
  cursor: '#00d8ff',
  cursorAccent: '#1d2022',
  selectionBackground: 'rgba(83, 139, 181, 0.3)',
  black: '#313537',
  red: '#bf5f54',
  green: '#58c98c',
  yellow: '#cfd77c',
  blue: '#538bb5',
  magenta: '#c99bf9',
  cyan: '#5aceca',
  white: '#e3edf5',
  brightBlack: '#5c6266',
  brightRed: '#d47466',
  brightGreen: '#60ec9f',
  brightYellow: '#e3ec93',
  brightBlue: '#5aceca',
  brightMagenta: '#d9b3fc',
  brightCyan: '#6cfcf9',
  brightWhite: '#f5fbff',
}

const PINE_LIGHT: TerminalPalette = {
  background: '#fbfcfd',
  foreground: '#24292f',
  cursor: '#0b62c4',
  cursorAccent: '#fbfcfd',
  selectionBackground: 'rgba(11, 98, 196, 0.22)',
  black: '#2b303b',
  red: '#c62828',
  green: '#1b7f3b',
  yellow: '#8a6100',
  blue: '#1f5fbf',
  magenta: '#a1349f',
  cyan: '#0b7285',
  white: '#5f6672',
  brightBlack: '#59616e',
  brightRed: '#d32f2f',
  brightGreen: '#1a7a35',
  brightYellow: '#946800',
  brightBlue: '#2b6fd6',
  brightMagenta: '#b53fb2',
  brightCyan: '#0c7a8d',
  brightWhite: '#3f4550',
}

const PALETTES: Record<string, TerminalPalette> = {
  adeberry: ADEBERRY,
  'one-dark-vivid': ONE_DARK_VIVID,
  'pine-light': PINE_LIGHT,
}

export function terminalPalette(themeId: string): TerminalPalette {
  return PALETTES[themeId] ?? ONE_DARK_VIVID
}
