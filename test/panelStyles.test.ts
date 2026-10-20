import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const extensions = join(__dirname, '..', 'src', 'extensions')
const SDK_OWNED = ['.page', '.toolbar', '.spacer', '.tabs', 'button.tab']

function panelStyles(): { id: string; css: string }[] {
  return readdirSync(extensions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        return [
          { id: entry.name, css: readFileSync(join(extensions, entry.name, 'panel.css'), 'utf8') },
        ]
      } catch {
        return []
      }
    })
}

function selectors(css: string): string[] {
  return [...css.matchAll(/(?:^|\})\s*([^{}@]+)\{/g)].flatMap((m) =>
    (m[1] ?? '').split(',').map((s) => s.trim()),
  )
}

describe('extension panel styles', () => {
  it('leave the toolbar, spacer, tabs and page to the SDK panel stylesheet', () => {
    const offenders = panelStyles().flatMap(({ id, css }) =>
      selectors(css)
        .filter((sel) => {
          const base = sel.split(/[\s:[]/)[0] ?? ''
          const head = sel.startsWith('button.tab') ? 'button.tab' : base
          return SDK_OWNED.includes(head)
        })
        .map((sel) => `${id}: ${sel}`),
    )
    expect(offenders).toEqual([])
  })
})
