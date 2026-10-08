import type { Dict } from '@shared/dict'

export type Appearance = 'dark' | 'light'

export interface Theme {
  id: string
  name: string
  appearance: Appearance
  colorScheme: string
  tokens: Record<string, string>
}

export const ANSI_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

export type AnsiName = (typeof ANSI_NAMES)[number]

export type TerminalColors = Record<AnsiName, string> & {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  selectionForeground?: string
}

export interface ColorScheme {
  id: string
  name: string
  appearance: Appearance
  colors: TerminalColors
}

export interface LanguageContribution {
  id: string
  label: string
  catalog: Dict
}

export interface PluginContributions {
  themes?: Theme[]
  colorSchemes?: ColorScheme[]
}

export interface PluginManifest {
  id: string
  name: string
  description: string
  version: string
  builtin: boolean
  contributes: PluginContributions
}
