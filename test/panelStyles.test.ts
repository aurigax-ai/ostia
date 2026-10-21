import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const extensions = join(__dirname, '..', 'src', 'extensions')
const SDK_OWNED = [
  '.page',
  '.ostia-page',
  '.ostia-spacer',
  '.toolbar',
  '.spacer',
  '.tabs',
  '.ostia-toolbar',
  '.ostia-tabs',
]
const TAB_BUTTONS = ['button.tab', 'button.ostia-tab']
const CORE_ROW_TOKENS =
  /ostia-toolbar|ostia-tabs|ostia-tab|panelToolbar|panelTab|role: 'tablist'|class: 'toolbar'/

function cssFiles(dir: string, prefix: string): { id: string; css: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return cssFiles(join(dir, entry.name), `${prefix}/${entry.name}`)
    return entry.name.endsWith('.css')
      ? [{ id: `${prefix}/${entry.name}`, css: readFileSync(join(dir, entry.name), 'utf8') }]
      : []
  })
}

function panelStyles(): { id: string; css: string }[] {
  return readdirSync(extensions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => cssFiles(join(extensions, entry.name), entry.name))
}

function selectors(css: string): string[] {
  return [...css.matchAll(/(?:^|\})\s*([^{}@]+)\{/g)].flatMap((m) =>
    (m[1] ?? '').split(',').map((s) => s.trim()),
  )
}

function hasPanel(id: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(extensions, id, 'ostia.json'), 'utf8'))
    return Boolean(manifest.contributes?.panel)
  } catch {
    return false
  }
}

function sourcesOf(id: string): { id: string; file: string; text: string }[] {
  return readdirSync(join(extensions, id))
    .filter((file) => /\.ts$/.test(file) && !/\.test\.ts$/.test(file))
    .map((file) => ({ id, file, text: readFileSync(join(extensions, id, file), 'utf8') }))
}

function drawsPill(id: string): boolean {
  return sourcesOf(id).some((source) => source.text.includes('extension-sdk/pill'))
}

function pageSources(): { id: string; file: string; text: string }[] {
  return readdirSync(extensions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => hasPanel(entry.name) || !drawsPill(entry.name))
    .flatMap((entry) =>
      sourcesOf(entry.name).filter((source) => source.text.includes('extension-sdk/panel')),
    )
}

describe('extension panel pages', () => {
  it('draw no toolbar, tab strip or close of their own: the core row above the page does', () => {
    const offenders = pageSources()
      .filter((source) => CORE_ROW_TOKENS.test(source.text))
      .map((source) => `${source.id}/${source.file}`)
    expect(offenders).toEqual([])
  })
})

describe('extension panel styles', () => {
  it('leave the toolbar, spacer, tabs and page to the SDK panel stylesheet', () => {
    const offenders = panelStyles().flatMap(({ id, css }) =>
      selectors(css)
        .filter((sel) => {
          const base = sel.split(/[\s:[]/)[0] ?? ''
          const tab = TAB_BUTTONS.find((button) => sel.startsWith(button))
          return tab !== undefined || SDK_OWNED.includes(base)
        })
        .map((sel) => `${id}: ${sel}`),
    )
    expect(offenders).toEqual([])
  })
})
