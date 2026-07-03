import type { FsEntry } from '@shared/types'
import {
  Database,
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileKey,
  FileLock,
  FileTerminal,
  FileText,
  FileType,
  Folder,
  FolderArchive,
  FolderCode,
  FolderCog,
  FolderGit2,
  FolderOpen,
  type LucideIcon,
  Package,
} from 'lucide-react'

/** One Dark Vivid accents for file-type tinting. */
const C = {
  blue: '#61afef',
  folder: '#6f8db0',
  yellow: '#e5c07b',
  green: '#89ca78',
  red: '#ef596f',
  magenta: '#d55fde',
  cyan: '#56b6c2',
  orange: '#d19a66',
  grey: '#7f8696',
}

type Glyph = [LucideIcon, string]

/** Special folders by (lowercased) name. */
const FOLDER: Record<string, Glyph> = {
  '.git': [FolderGit2, C.orange],
  '.github': [FolderGit2, C.grey],
  node_modules: [FolderArchive, C.grey],
  dist: [FolderArchive, C.grey],
  build: [FolderArchive, C.grey],
  out: [FolderArchive, C.grey],
  target: [FolderArchive, C.grey],
  '.cache': [FolderArchive, C.grey],
  src: [FolderCode, C.blue],
  lib: [FolderCode, C.blue],
  app: [FolderCode, C.blue],
  components: [FolderCode, C.blue],
  '.vscode': [FolderCog, C.grey],
  '.config': [FolderCog, C.grey],
  '.idea': [FolderCog, C.grey],
}

/** Specific filenames (checked before extension). */
const NAME: Record<string, Glyph> = {
  'package.json': [Package, C.red],
  'package-lock.json': [Package, C.grey],
  'pnpm-lock.yaml': [Package, C.grey],
  'readme.md': [FileText, C.blue],
  license: [FileText, C.grey],
  '.gitignore': [FileCog, C.grey],
  '.npmrc': [FileCog, C.grey],
  '.env': [FileKey, C.yellow],
  dockerfile: [FileCode, C.cyan],
}

/** By extension. */
const EXT: Record<string, Glyph> = {
  ts: [FileCode, C.blue],
  tsx: [FileCode, C.blue],
  mts: [FileCode, C.blue],
  cts: [FileCode, C.blue],
  js: [FileCode, C.yellow],
  jsx: [FileCode, C.yellow],
  mjs: [FileCode, C.yellow],
  cjs: [FileCode, C.yellow],
  json: [FileJson, C.yellow],
  jsonc: [FileJson, C.yellow],
  css: [FileType, C.magenta],
  scss: [FileType, C.magenta],
  sass: [FileType, C.magenta],
  less: [FileType, C.magenta],
  html: [FileCode, C.orange],
  htm: [FileCode, C.orange],
  md: [FileText, C.blue],
  mdx: [FileText, C.blue],
  sh: [FileTerminal, C.green],
  zsh: [FileTerminal, C.green],
  bash: [FileTerminal, C.green],
  fish: [FileTerminal, C.green],
  png: [FileImage, C.green],
  jpg: [FileImage, C.green],
  jpeg: [FileImage, C.green],
  gif: [FileImage, C.green],
  webp: [FileImage, C.green],
  ico: [FileImage, C.green],
  svg: [FileImage, C.magenta],
  toml: [FileCog, C.grey],
  yaml: [FileCog, C.grey],
  yml: [FileCog, C.grey],
  ini: [FileCog, C.grey],
  conf: [FileCog, C.grey],
  lock: [FileLock, C.grey],
  zip: [FileArchive, C.grey],
  tar: [FileArchive, C.grey],
  gz: [FileArchive, C.grey],
  xz: [FileArchive, C.grey],
  db: [Database, C.cyan],
  sqlite: [Database, C.cyan],
  py: [FileCode, C.blue],
  rs: [FileCode, C.orange],
  go: [FileCode, C.cyan],
}

/** Pick a tinted icon for a filesystem entry (VSCode-ish, on the One Dark palette). */
export function fileIcon(entry: FsEntry, open = false): { Icon: LucideIcon; color: string } {
  const name = entry.name.toLowerCase()
  if (entry.dir) {
    const m = FOLDER[name]
    if (m) return { Icon: m[0], color: m[1] }
    return { Icon: open ? FolderOpen : Folder, color: C.folder }
  }
  const byName = NAME[name]
  if (byName) return { Icon: byName[0], color: byName[1] }
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  const byExt = EXT[ext]
  if (byExt) return { Icon: byExt[0], color: byExt[1] }
  if (name.startsWith('.')) return { Icon: FileCog, color: C.grey }
  return { Icon: File, color: C.grey }
}
