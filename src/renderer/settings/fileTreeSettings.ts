import { BUILTIN_ICON_THEME, ICON_THEME_ID_PATTERN } from '../../shared/iconTheme'

export type FileSortOrder = 'foldersFirst' | 'mixed'
export type FileSortBy = 'name' | 'type'

export const FILE_SORT_ORDERS: readonly FileSortOrder[] = ['foldersFirst', 'mixed']
export const FILE_SORT_BYS: readonly FileSortBy[] = ['name', 'type']

export interface FileNestingSettings {
  enabled: boolean
  patterns: Record<string, string>
}

export interface FileTreeSettings {
  exclude: string[]
  showExcluded: boolean
  compactFolders: boolean
  nesting: FileNestingSettings
  sortOrder: FileSortOrder
  sortBy: FileSortBy
  iconTheme: string
}

export const DOTFILES_PATTERN = '**/.*'

export const EXCLUDE_MAX = 200
export const PATTERN_MAX_LENGTH = 500
export const NESTING_MAX = 100

export const DEFAULT_NESTING_PATTERNS: Record<string, string> = {
  'package.json':
    'package-lock.json, pnpm-lock.yaml, pnpm-workspace.yaml, yarn.lock, bun.lock, bun.lockb, .npmrc',
  'Cargo.toml': 'Cargo.lock',
  'go.mod': 'go.sum, go.work, go.work.sum',
  'pyproject.toml': 'uv.lock, poetry.lock, setup.cfg, requirements*.txt',
  'tsconfig.json': 'tsconfig.*.json',
  '*.ts': '${capture}.test.ts, ${capture}.spec.ts, ${capture}.d.ts, ${capture}.js',
  '*.tsx': '${capture}.test.tsx, ${capture}.spec.tsx, ${capture}.module.css, ${capture}.css',
  '*.js':
    '${capture}.test.js, ${capture}.spec.js, ${capture}.js.map, ${capture}.min.js, ${capture}.d.ts',
  '.gitignore': '.gitattributes, .gitmodules',
}

export const DEFAULT_FILE_TREE_SETTINGS: FileTreeSettings = {
  exclude: ['**/.git', '**/.hg', '**/.svn', '**/.DS_Store', '**/Thumbs.db'],
  showExcluded: false,
  compactFolders: true,
  nesting: { enabled: true, patterns: DEFAULT_NESTING_PATTERNS },
  sortOrder: 'foldersFirst',
  sortBy: 'name',
  iconTheme: BUILTIN_ICON_THEME,
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const pattern = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() && v.length <= PATTERN_MAX_LENGTH ? v.trim() : null

function parseExclude(raw: unknown): string[] {
  if (!Array.isArray(raw)) return DEFAULT_FILE_TREE_SETTINGS.exclude
  const out: string[] = []
  for (const item of raw) {
    const p = pattern(item)
    if (p && !out.includes(p)) out.push(p)
    if (out.length >= EXCLUDE_MAX) break
  }
  return out
}

function parseNestingPatterns(raw: unknown): Record<string, string> {
  if (!isPlainObject(raw)) return DEFAULT_NESTING_PATTERNS
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= NESTING_MAX) break
    const k = pattern(key)
    const v = pattern(value)
    if (k && v && k === key) out[k] = v
  }
  return out
}

export function parseFileTreeSettings(raw: unknown): FileTreeSettings {
  const base = DEFAULT_FILE_TREE_SETTINGS
  if (!isPlainObject(raw)) return base
  const nesting = isPlainObject(raw.nesting) ? raw.nesting : {}
  return {
    exclude: parseExclude(raw.exclude),
    showExcluded: typeof raw.showExcluded === 'boolean' ? raw.showExcluded : base.showExcluded,
    compactFolders:
      typeof raw.compactFolders === 'boolean' ? raw.compactFolders : base.compactFolders,
    nesting: {
      enabled: typeof nesting.enabled === 'boolean' ? nesting.enabled : base.nesting.enabled,
      patterns: parseNestingPatterns(nesting.patterns),
    },
    sortOrder: FILE_SORT_ORDERS.includes(raw.sortOrder as FileSortOrder)
      ? (raw.sortOrder as FileSortOrder)
      : base.sortOrder,
    sortBy: FILE_SORT_BYS.includes(raw.sortBy as FileSortBy)
      ? (raw.sortBy as FileSortBy)
      : base.sortBy,
    iconTheme:
      typeof raw.iconTheme === 'string' && ICON_THEME_ID_PATTERN.test(raw.iconTheme)
        ? raw.iconTheme
        : base.iconTheme,
  }
}
