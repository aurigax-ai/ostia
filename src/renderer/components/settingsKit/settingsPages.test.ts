import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER = resolve(process.cwd(), 'src/renderer')
const PANEL = resolve(RENDERER, 'components/settings/SettingsPanel.tsx')

const RULES = {
  root: (text: string) => !text.includes('<SettingsPage'),
  separator: (text: string) => text.includes('<Separator'),
  negativeMargin: (text: string) => /[\s"'`:]-mx-\d/.test(text),
  divide: (text: string) => text.includes('divide-y'),
  handHeading: (text: string) => /<h[234]\b/.test(text),
  handSection: (text: string) => /<section\b/.test(text),
}

type Rule = keyof typeof RULES

const KNOWN_OFFENDERS: Record<string, Rule[]> = {
  'components/app/AboutSection.tsx': ['root', 'handHeading', 'handSection'],
  'components/gateway/GatewaySection.tsx': ['separator'],
  'components/languageServers/LanguagesSection.tsx': ['negativeMargin'],
  'components/settings/PrivacySection.tsx': ['handHeading'],
  'components/settings/PromptSection.tsx': ['divide', 'handSection'],
  'components/settings/SyncSection.tsx': ['separator'],
  'components/views/ViewsSection.tsx': ['negativeMargin'],
}

function renderedPageFiles(): string[] {
  const panel = readFileSync(PANEL, 'utf8')
  const start = panel.indexOf('const page = ')
  const end = panel.indexOf('if (!searching)')
  const names = new Set([...panel.slice(start, end).matchAll(/<([A-Z]\w+)/g)].map((m) => m[1]))
  const files: string[] = []
  for (const name of names) {
    const found = panel.match(
      new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'([^']+)'`),
    )
    if (!found) continue
    const spec = found[1]
    const base = spec.startsWith('@/')
      ? resolve(RENDERER, spec.slice(2))
      : spec.startsWith('.')
        ? resolve(dirname(PANEL), spec)
        : null
    if (base) files.push(`${base}.tsx`)
  }
  return [...new Set(files)].sort()
}

describe('settings pages', () => {
  const files = renderedPageFiles()

  it('finds the pages the panel renders', () => {
    expect(files.length).toBeGreaterThan(25)
  })

  it('only drift from the page standard where the known offenders list says so', () => {
    const found: Record<string, Rule[]> = {}
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      const broken = (Object.keys(RULES) as Rule[]).filter((rule) => RULES[rule](text))
      if (broken.length > 0) found[file.slice(RENDERER.length + 1)] = broken
    }
    expect(found).toEqual(KNOWN_OFFENDERS)
  })
})
