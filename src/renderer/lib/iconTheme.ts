import type { IconAssociations, LoadedIconTheme } from '@shared/iconTheme'

export type IconVariant = 'dark' | 'light' | 'highContrast'

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascriptreact',
  json: 'json',
  jsonc: 'jsonc',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  yml: 'yaml',
  yaml: 'yaml',
  ini: 'ini',
  sql: 'sql',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  java: 'java',
  lua: 'lua',
  rb: 'ruby',
  php: 'php',
  xml: 'xml',
  svg: 'xml',
  txt: 'plaintext',
  bat: 'bat',
  ps1: 'powershell',
  pl: 'perl',
  r: 'r',
  swift: 'swift',
  fs: 'fsharp',
  groovy: 'groovy',
  hbs: 'handlebars',
  diff: 'diff',
  patch: 'diff',
  log: 'log',
  properties: 'properties',
  dart: 'dart',
  jl: 'julia',
  tex: 'latex',
  coffee: 'coffeescript',
  vue: 'vue',
}

const LANGUAGE_BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  '.gitignore': 'ignore',
  '.dockerignore': 'ignore',
  '.bashrc': 'shellscript',
  '.zshrc': 'shellscript',
}

const own = (map: Record<string, string>, key: string): string | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined

export function languageIdFor(name: string): string | undefined {
  const lower = name.toLowerCase()
  const byName = own(LANGUAGE_BY_NAME, lower)
  if (byName) return byName
  const dot = lower.lastIndexOf('.')
  return dot >= 0 ? own(LANGUAGE_BY_EXTENSION, lower.slice(dot + 1)) : undefined
}

function extensionCandidates(name: string): string[] {
  const out: string[] = []
  let dot = name.indexOf('.')
  while (dot >= 0) {
    const ext = name.slice(dot + 1)
    if (ext) out.push(ext)
    dot = name.indexOf('.', dot + 1)
  }
  return out
}

function sections(theme: LoadedIconTheme, variant: IconVariant): IconAssociations[] {
  const overlay =
    variant === 'light' ? theme.light : variant === 'highContrast' ? theme.highContrast : undefined
  return overlay ? [overlay, theme.base] : [theme.base]
}

function lookup(
  layers: IconAssociations[],
  pick: (a: IconAssociations) => Record<string, string>,
  key: string | undefined,
): string | undefined {
  if (key === undefined) return undefined
  for (const layer of layers) {
    const hit = own(pick(layer), key)
    if (hit) return hit
  }
  return undefined
}

function firstDefined(
  layers: IconAssociations[],
  pick: (a: IconAssociations) => string | undefined,
): string | undefined {
  for (const layer of layers) {
    const hit = pick(layer)
    if (hit) return hit
  }
  return undefined
}

export function themeIconId(
  theme: LoadedIconTheme,
  entry: { name: string; dir: boolean },
  expanded: boolean,
  variant: IconVariant = 'dark',
): string | undefined {
  const layers = sections(theme, variant)
  const name = entry.name.toLowerCase()
  if (entry.dir) {
    if (expanded) {
      return (
        lookup(layers, (a) => a.folderNamesExpanded, name) ??
        lookup(layers, (a) => a.folderNames, name) ??
        firstDefined(layers, (a) => a.folderExpanded) ??
        firstDefined(layers, (a) => a.folder)
      )
    }
    return lookup(layers, (a) => a.folderNames, name) ?? firstDefined(layers, (a) => a.folder)
  }
  const byName = lookup(layers, (a) => a.fileNames, name)
  if (byName) return byName
  for (const ext of extensionCandidates(name)) {
    const byExt = lookup(layers, (a) => a.fileExtensions, ext)
    if (byExt) return byExt
  }
  return (
    lookup(layers, (a) => a.languageIds, languageIdFor(name)) ?? firstDefined(layers, (a) => a.file)
  )
}

export function themeIconSrc(
  theme: LoadedIconTheme,
  entry: { name: string; dir: boolean },
  expanded: boolean,
  variant: IconVariant = 'dark',
): string | null {
  const id = themeIconId(theme, entry, expanded, variant)
  return id && Object.hasOwn(theme.icons, id) ? theme.icons[id] : null
}
