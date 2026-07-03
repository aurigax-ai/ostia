import { en, zhHant } from '../i18n/dict'
import type { PluginManifest, Theme } from './types'

/**
 * Built-in themes. Each is a full set of --color-* primitive overrides; the semantic
 * tokens in index.css reference these, so overriding the palette re-themes everything.
 */
const oneDarkVivid: Theme = {
  id: 'one-dark-vivid',
  name: 'One Dark Vivid',
  appearance: 'dark',
  tokens: {
    bg: '#21252b',
    'bg-sunken': '#1b1e23',
    'surface-1': '#282c34',
    'surface-2': '#2f343e',
    'surface-3': '#3a4150',
    line: 'rgba(255, 255, 255, 0.07)',
    'line-strong': 'rgba(255, 255, 255, 0.13)',
    fg: '#d7dae0',
    'fg-muted': '#9aa2b1',
    'fg-dim': '#636d83',
    brand: '#61afef',
    'brand-bright': '#82c7ff',
    'brand-glow': 'rgba(97, 175, 239, 0.18)',
    attn: '#ef596f',
    'attn-glow': 'rgba(239, 89, 111, 0.2)',
    ok: '#89ca78',
    add: '#89ca78',
    del: '#ef596f',
  },
}

const instrumentNight: Theme = {
  id: 'instrument-night',
  name: 'Instrument Night',
  appearance: 'dark',
  tokens: {
    bg: '#0a0c12',
    'bg-sunken': '#06080d',
    'surface-1': '#10131c',
    'surface-2': '#161a26',
    'surface-3': '#1d2230',
    line: 'rgba(255, 255, 255, 0.08)',
    'line-strong': 'rgba(255, 255, 255, 0.15)',
    fg: '#e7e9f0',
    'fg-muted': '#8b91a4',
    'fg-dim': '#565d72',
    brand: '#f2b347',
    'brand-bright': '#ffc874',
    'brand-glow': 'rgba(242, 179, 71, 0.16)',
    attn: '#ff6b5e',
    'attn-glow': 'rgba(255, 107, 94, 0.18)',
    ok: '#5bd6a0',
    add: '#3fb950',
    del: '#f85149',
  },
}

const dracula: Theme = {
  id: 'dracula',
  name: 'Dracula',
  appearance: 'dark',
  tokens: {
    bg: '#282a36',
    'bg-sunken': '#21222c',
    'surface-1': '#2d2f3d',
    'surface-2': '#343746',
    'surface-3': '#44475a',
    line: 'rgba(255, 255, 255, 0.07)',
    'line-strong': 'rgba(255, 255, 255, 0.14)',
    fg: '#f8f8f2',
    'fg-muted': '#b9bcca',
    'fg-dim': '#6272a4',
    brand: '#bd93f9',
    'brand-bright': '#d6b3ff',
    'brand-glow': 'rgba(189, 147, 249, 0.18)',
    attn: '#ff5555',
    'attn-glow': 'rgba(255, 85, 85, 0.2)',
    ok: '#50fa7b',
    add: '#50fa7b',
    del: '#ff5555',
  },
}

const oxocarbon: Theme = {
  id: 'oxocarbon',
  name: 'Oxocarbon',
  appearance: 'dark',
  tokens: {
    bg: '#161616',
    'bg-sunken': '#0d0d0d',
    'surface-1': '#1c1c1c',
    'surface-2': '#262626',
    'surface-3': '#393939',
    line: 'rgba(255, 255, 255, 0.09)',
    'line-strong': 'rgba(255, 255, 255, 0.16)',
    fg: '#f2f4f8',
    'fg-muted': '#a8a8a8',
    'fg-dim': '#525252',
    brand: '#be95ff',
    'brand-bright': '#d4b8ff',
    'brand-glow': 'rgba(190, 149, 255, 0.18)',
    attn: '#ee5396',
    'attn-glow': 'rgba(238, 83, 150, 0.2)',
    ok: '#42be65',
    add: '#42be65',
    del: '#ee5396',
  },
}

/**
 * Built-in plugins — the same contribution mechanism third-party plugins will use. The
 * Themes plugin contributes the color themes; the Language Servers plugin is the umbrella
 * for the servers spawned by main (status is merged in from `lsp:list` at runtime).
 */
export const BUILTIN_PLUGINS: PluginManifest[] = [
  {
    id: 'pine.themes',
    name: 'Core Themes',
    description: 'The built-in color themes.',
    version: '1.0.0',
    builtin: true,
    contributes: { themes: [oneDarkVivid, instrumentNight, dracula, oxocarbon] },
  },
  {
    id: 'pine.lsp',
    name: 'Language Servers',
    description: 'Auto-detected language servers for the editor.',
    version: '1.0.0',
    builtin: true,
    contributes: { languageServers: [] },
  },
  {
    id: 'pine.lang.en',
    name: 'English',
    description: 'English language pack.',
    version: '1.0.0',
    builtin: true,
    contributes: { languages: [{ id: 'en', label: 'English', catalog: en }] },
  },
  {
    id: 'pine.lang.zh-hant',
    name: 'Traditional Chinese · 繁體中文',
    description: 'Traditional Chinese language pack.',
    version: '1.0.0',
    builtin: true,
    contributes: { languages: [{ id: 'zh-Hant', label: '繁體中文', catalog: zhHant }] },
  },
]
