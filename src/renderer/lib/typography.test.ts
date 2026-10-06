import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()

function sourceFiles(dir: string, extensions: string[]): string[] {
  const root = resolve(ROOT, dir)
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => extensions.some((ext) => f.endsWith(ext)) && !/\.test\.tsx?$/.test(f))
    .map((f) => join(root, f))
}

const GENERATED = [/src\/renderer\/components\/ui\//, /src\/renderer\/assets\/fonts\//]

const RELATIVE_SCALE_FILES = new Map([
  [
    'src/renderer/typeset.css',
    'vendored shadcn Typeset: markdown steps are ems on top of --typeset-size, set to a token',
  ],
])

const SETTINGS_FONT_FILES = new Map([
  ['src/renderer/components/Terminal.tsx', 'passes the terminal font settings to xterm'],
  ['src/renderer/components/ManagerView.tsx', 'passes the terminal font settings to xterm'],
  ['src/renderer/components/GhosttyTerminal.tsx', 'passes the terminal font settings to Ghostty'],
  ['src/renderer/components/Editor.tsx', 'passes the editor font settings to Monaco'],
  ['src/renderer/components/DiffView.tsx', 'passes the editor font settings to Monaco'],
  [
    'src/renderer/components/InputEditor.tsx',
    'draws over xterm cells, so it takes the terminal font, cell height and cell width',
  ],
  ['src/renderer/components/ThemeSettings.tsx', 'previews the terminal and editor fonts'],
  ['src/renderer/components/FontPicker.tsx', 'shows each family in its own face'],
  ['src/renderer/stores/settingsStore.ts', 'the font settings model itself'],
  ['src/renderer/settings/settingsSchema.ts', 'the JSON schema of the font settings'],
  ['src/renderer/i18n/dict.ts', 'labels for the font settings'],
])

const FONT_FACE_FILES = new Map([
  ['src/renderer/lib/panelFontFaces.ts', 'writes @font-face descriptors for extension panels'],
])

const DECLARATION_EXCEPTIONS = new Map([
  [
    'src/renderer/index.css: font-size: calc(var(--text-scale-factor) * var(--font-height))',
    'pdf.js text layer: sized to the glyphs of the PDF page',
  ],
  ['src/renderer/index.css: line-height: 1', 'pdf.js text layer: one line box per PDF text run'],
])

type Property = 'font-family' | 'font-size' | 'font-weight' | 'line-height' | 'letter-spacing'

const TOKENS: Record<Property, { names: RegExp; keywords: string[]; use: string }> = {
  'font-family': {
    names: /^--(?:(?:ostia-)?font-(?:ui|code)|typeset-font-(?:body|heading|mono))$/,
    keywords: ['inherit'],
    use: 'var(--font-ui) for UI text or var(--font-code) for code, paths and other machine text',
  },
  'font-size': {
    names: /^--(?:text-ui-(?:xs|sm|base|emphasis|lg)|ostia-font-size)$/,
    keywords: ['inherit'],
    use: 'var(--text-ui-xs|sm|base|emphasis|lg) (DESIGN.md §4)',
  },
  'font-weight': {
    names: /^--(?:font-weight-(?:normal|medium|semibold)|ostia-font-weight)$/,
    keywords: ['inherit'],
    use: 'var(--font-weight-normal|medium|semibold), which follow the UI weight setting',
  },
  'line-height': {
    names: /^--(?:text-ui-(?:xs|sm|base|emphasis|lg)--line-height|ostia-font-size)$/,
    keywords: ['inherit'],
    use: 'the line height of the same step, var(--text-ui-<step>--line-height)',
  },
  'letter-spacing': {
    names: /^--tracking-caps$/,
    keywords: ['inherit', 'normal'],
    use: 'var(--tracking-caps) for all-caps labels, else normal',
  },
}

const ARITHMETIC = /^[\s\d.,+\-*/()]*(?:(?:px|em)\b[\s\d.,+\-*/()]*)*$/

function stripFontFaces(source: string): string {
  return source.replace(/@font-face\s*\{[^}]*\}/g, '')
}

function typographyProblems(source: string, inCode = false): string[] {
  const problems: string[] = []
  const decl =
    /(?<![\w-])(font-family|font-size|font-weight|line-height|letter-spacing|font)\s*:\s*([^;{}`"'\n]+)/g
  for (const [, property, raw] of stripFontFaces(source).matchAll(decl)) {
    const value = raw.trim()
    if (property === 'font') {
      const cssShorthand = !inCode || /^[\d.]/.test(value)
      if (value !== 'inherit' && cssShorthand)
        problems.push(`font: ${value} → set font-family, size and weight with tokens`)
      continue
    }
    const token = TOKENS[property as Property]
    if (token.keywords.includes(value)) continue
    const vars = [...value.matchAll(/var\(\s*(--[\w-]+)[^()]*\)/g)]
    const rest = value.replace(/var\(\s*--[\w-]+[^()]*\)/g, '').replace(/\b(?:calc|max|min)\b/g, '')
    const tokenOnly =
      vars.length > 0 && vars.every(([, name]) => token.names.test(name)) && ARITHMETIC.test(rest)
    if (!tokenOnly) problems.push(`${property}: ${value} → use ${token.use}`)
  }
  return problems
}

const CLASS_RULES: { pattern: RegExp; use: string }[] = [
  {
    pattern: /\btext-(?:xs|sm|base|lg|[2-9]?xl)\b/,
    use: 'text-ui-xs|sm|base|emphasis|lg (Tailwind sizes are only for generated shadcn files)',
  },
  { pattern: /\btext-\[\d/, use: 'a text-ui-* step instead of an arbitrary size' },
  {
    pattern: /\bfont-(?:thin|extralight|light|bold|extrabold|black|serif)\b/,
    use: 'font-normal, font-medium or font-semibold',
  },
  { pattern: /\bfont-\[/, use: 'font-sans (UI font), font-mono (code font) or a weight token' },
  { pattern: /\bleading-[\w[]/, use: 'the line height that comes with the text-ui-* step' },
  { pattern: /\btracking-(?!normal\b|caps\b)[\w[]/, use: 'tracking-caps or tracking-normal' },
]

const STYLE_KEYS =
  /\b(fontFamily|fontSize|fontWeight|lineHeight|letterSpacing)(?:\s*:|=\{)|\.style\.(?:fontFamily|fontSize|fontWeight|lineHeight|letterSpacing)\s*=|\bctx\.font\s*=/

function classProblems(line: string): string[] {
  return CLASS_RULES.flatMap(({ pattern, use }) => {
    const at = line.search(pattern)
    if (at < 0) return []
    const name = line.slice(at).match(/^[^\s"'`]+/)?.[0]
    return [`${name} → use ${use}`]
  })
}

function styleKeyProblem(line: string): string | null {
  const match = line.match(STYLE_KEYS)
  return match
    ? `${match[0]} → typography comes from CSS tokens; only files that hand font settings to xterm or Monaco may set it inline`
    : null
}

const rel = (file: string): string => relative(ROOT, file)

const styleFiles = [
  ...sourceFiles('src/renderer', ['.css']),
  ...sourceFiles('src/extensions', ['.css']),
].filter((f) => !GENERATED.some((re) => re.test(f)))

const codeFiles = [
  ...sourceFiles('src/renderer', ['.ts', '.tsx']),
  ...sourceFiles('src/extensions', ['.ts', '.tsx']),
].filter((f) => !GENERATED.some((re) => re.test(f)) && !f.endsWith('.d.ts'))

function fileDeclarationProblems(file: string): string[] {
  const name = rel(file)
  if (FONT_FACE_FILES.has(name)) return []
  const relativeScale = RELATIVE_SCALE_FILES.has(name)
  return typographyProblems(readFileSync(file, 'utf8'), /\.tsx?$/.test(name))
    .filter((p) => !DECLARATION_EXCEPTIONS.has(`${name}: ${p.split(' → ')[0]}`))
    .filter((p) => !(relativeScale && /^(?:font-size|line-height|letter-spacing):/.test(p)))
    .map((p) => `${name}: ${p}`)
}

describe('typography guard', () => {
  it('sets every font size, family, weight, line height and letter spacing in CSS with tokens', () => {
    expect(styleFiles.flatMap(fileDeclarationProblems)).toEqual([])
  })

  it('keeps CSS written inside code (panel pages, injected styles) on the tokens too', () => {
    expect(codeFiles.flatMap(fileDeclarationProblems)).toEqual([])
  })

  it('uses only the token type classes in components', () => {
    const offenders = codeFiles.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => classProblems(line).map((p) => `${rel(file)}:${i + 1} ${p}`)),
    )
    expect(offenders).toEqual([])
  })

  it('sets no inline font styles outside the files that pass font settings to xterm or Monaco', () => {
    const offenders = codeFiles
      .filter((file) => !SETTINGS_FONT_FILES.has(rel(file)))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .flatMap((line, i) => {
            const problem = styleKeyProblem(line)
            return problem ? [`${rel(file)}:${i + 1} ${problem}`] : []
          }),
      )
    expect(offenders).toEqual([])
  })

  it('still points at real files for every exception', () => {
    for (const name of [
      ...SETTINGS_FONT_FILES.keys(),
      ...RELATIVE_SCALE_FILES.keys(),
      ...FONT_FACE_FILES.keys(),
    ]) {
      expect(() => readFileSync(resolve(ROOT, name)), name).not.toThrow()
    }
  })
})

describe('typography checks', () => {
  it('flags raw sizes, families, weights, line heights and tracking in CSS', () => {
    const css =
      '.a { font-size: 12px; font-family: monospace; font-weight: 600; line-height: 1.4; letter-spacing: 0.04em; font: 13px/20px Inter; }'
    expect(typographyProblems(css).map((p) => p.split(':')[0])).toEqual([
      'font-size',
      'font-family',
      'font-weight',
      'line-height',
      'letter-spacing',
      'font',
    ])
    expect(typographyProblems('.a { font-size: 0.85em }')[0]).toContain('var(--text-ui-')
    expect(typographyProblems('const css = `body{font:13px/20px Inter}`', true)).toHaveLength(1)
    expect(typographyProblems('function f(font: string) {}', true)).toEqual([])
  })

  it('accepts token values, token arithmetic and inherit', () => {
    const css = `.a { font-size: var(--text-ui-xs); line-height: var(--text-ui-xs--line-height); font-family: var(--font-code); font-weight: var(--font-weight-medium); letter-spacing: var(--tracking-caps); font: inherit; }
      .b { font-size: calc(var(--ostia-font-size,13px) + 3px); font-family: var(--ostia-font-ui,system-ui,sans-serif); letter-spacing: normal; }
      @font-face { font-family: "Hack"; font-weight: 400; }`
    expect(typographyProblems(css)).toEqual([])
  })

  it('refuses a token from the wrong family of tokens', () => {
    expect(typographyProblems('.a { font-size: var(--font-weight-medium) }')).toHaveLength(1)
    expect(typographyProblems('.a { font-family: var(--brand) }')).toHaveLength(1)
  })

  it('flags Tailwind sizes, weights, arbitrary fonts, leading and tracking in class names', () => {
    for (const cls of [
      'text-sm',
      'text-xs',
      'text-lg',
      'text-2xl',
      'text-[13px]',
      'font-bold',
      'font-light',
      'font-[Inter]',
      'leading-tight',
      'leading-[18px]',
      'tracking-wide',
      'tracking-[0.1em]',
    ]) {
      expect(classProblems(`<span className="${cls} text-fg" />`), cls).toHaveLength(1)
    }
    expect(
      classProblems(
        '<span className="text-ui-sm font-medium font-mono tracking-caps tracking-normal text-fg-muted" />',
      ),
    ).toEqual([])
  })

  it('flags inline font styles and canvas fonts', () => {
    expect(styleKeyProblem('<p style={{ fontSize: 12 }} />')).not.toBeNull()
    expect(styleKeyProblem('<Chip fontFamily={stack} />')).not.toBeNull()
    expect(styleKeyProblem('el.style.lineHeight = "20px"')).not.toBeNull()
    expect(styleKeyProblem('ctx.font = `12px mono`')).not.toBeNull()
    expect(styleKeyProblem('const lineHeight = useSettings()')).toBeNull()
  })
})
