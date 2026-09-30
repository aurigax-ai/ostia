import {
  BracketsCurlyIcon,
  DatabaseIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileLockIcon,
  FileTextIcon,
  FileZipIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderSimpleIcon,
  GearSixIcon,
  GitForkIcon,
  type Icon as IconComponent,
  KeyIcon,
  PackageIcon,
  TerminalWindowIcon,
  TextAaIcon,
} from '@phosphor-icons/react'
import type { FsEntry } from '@shared/types'

const hue = (group: string): string => `color-mix(in srgb, var(--group-${group}) 72%, var(--fg))`

const C = {
  blue: hue('blue'),
  folder: 'color-mix(in srgb, var(--group-blue) 45%, var(--fg-muted))',
  yellow: hue('yellow'),
  green: hue('green'),
  red: hue('red'),
  magenta: hue('purple'),
  cyan: hue('teal'),
  orange: hue('orange'),
  grey: 'var(--fg-muted)',
}

type Glyph = [IconComponent, string]

const FOLDER: Record<string, Glyph> = {
  '.git': [GitForkIcon, C.orange],
  '.github': [GitForkIcon, C.grey],
  node_modules: [FolderSimpleIcon, C.grey],
  dist: [FolderSimpleIcon, C.grey],
  build: [FolderSimpleIcon, C.grey],
  out: [FolderSimpleIcon, C.grey],
  target: [FolderSimpleIcon, C.grey],
  '.cache': [FolderSimpleIcon, C.grey],
  src: [FolderSimpleIcon, C.blue],
  lib: [FolderSimpleIcon, C.blue],
  app: [FolderSimpleIcon, C.blue],
  components: [FolderSimpleIcon, C.blue],
  '.vscode': [FolderSimpleIcon, C.grey],
  '.config': [FolderSimpleIcon, C.grey],
  '.idea': [FolderSimpleIcon, C.grey],
}

const NAME: Record<string, Glyph> = {
  'package.json': [PackageIcon, C.red],
  'package-lock.json': [PackageIcon, C.grey],
  'pnpm-lock.yaml': [PackageIcon, C.grey],
  'readme.md': [FileTextIcon, C.blue],
  license: [FileTextIcon, C.grey],
  '.gitignore': [GearSixIcon, C.grey],
  '.npmrc': [GearSixIcon, C.grey],
  '.env': [KeyIcon, C.yellow],
  dockerfile: [FileCodeIcon, C.cyan],
}

const EXT: Record<string, Glyph> = {
  ts: [FileCodeIcon, C.blue],
  tsx: [FileCodeIcon, C.blue],
  mts: [FileCodeIcon, C.blue],
  cts: [FileCodeIcon, C.blue],
  js: [FileCodeIcon, C.yellow],
  jsx: [FileCodeIcon, C.yellow],
  mjs: [FileCodeIcon, C.yellow],
  cjs: [FileCodeIcon, C.yellow],
  json: [BracketsCurlyIcon, C.yellow],
  jsonc: [BracketsCurlyIcon, C.yellow],
  css: [TextAaIcon, C.magenta],
  scss: [TextAaIcon, C.magenta],
  sass: [TextAaIcon, C.magenta],
  less: [TextAaIcon, C.magenta],
  html: [FileCodeIcon, C.orange],
  htm: [FileCodeIcon, C.orange],
  md: [FileTextIcon, C.blue],
  mdx: [FileTextIcon, C.blue],
  sh: [TerminalWindowIcon, C.green],
  zsh: [TerminalWindowIcon, C.green],
  bash: [TerminalWindowIcon, C.green],
  fish: [TerminalWindowIcon, C.green],
  png: [FileImageIcon, C.green],
  jpg: [FileImageIcon, C.green],
  jpeg: [FileImageIcon, C.green],
  gif: [FileImageIcon, C.green],
  webp: [FileImageIcon, C.green],
  ico: [FileImageIcon, C.green],
  svg: [FileImageIcon, C.magenta],
  toml: [GearSixIcon, C.grey],
  yaml: [GearSixIcon, C.grey],
  yml: [GearSixIcon, C.grey],
  ini: [GearSixIcon, C.grey],
  conf: [GearSixIcon, C.grey],
  lock: [FileLockIcon, C.grey],
  zip: [FileZipIcon, C.grey],
  tar: [FileZipIcon, C.grey],
  gz: [FileZipIcon, C.grey],
  xz: [FileZipIcon, C.grey],
  db: [DatabaseIcon, C.cyan],
  sqlite: [DatabaseIcon, C.cyan],
  py: [FileCodeIcon, C.blue],
  rs: [FileCodeIcon, C.orange],
  go: [FileCodeIcon, C.cyan],
}

export function fileIcon(entry: FsEntry, open = false): { Icon: IconComponent; color: string } {
  const name = entry.name.toLowerCase()
  if (entry.dir) {
    const m = FOLDER[name]
    if (m) return { Icon: m[0], color: m[1] }
    return { Icon: open ? FolderOpenIcon : FolderIcon, color: C.folder }
  }
  const byName = NAME[name]
  if (byName) return { Icon: byName[0], color: byName[1] }
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  const byExt = EXT[ext]
  if (byExt) return { Icon: byExt[0], color: byExt[1] }
  if (name.startsWith('.')) return { Icon: GearSixIcon, color: C.grey }
  return { Icon: FileIcon, color: C.grey }
}
