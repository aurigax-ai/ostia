import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCROLLBAR_SIZE_PX } from '@aurigax-ai/ostia-extension-sdk/contract/scrollbar'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const APP_CSS = 'src/renderer/index.css'
const PANEL_CSS = 'packages/extension-sdk/src/client/panel.css'
const SHARED = [APP_CSS, PANEL_CSS]

const sources = execFileSync('git', ['ls-files', '*.css', '*.html', '*.ts', '*.tsx'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter((file) => file && !/\.test\.tsx?$|^(test|e2e|scripts)\//.test(file))

function read(file: string): string {
  return readFileSync(join(root, file), 'utf8')
}

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) return ''
  return css.slice(start, css.indexOf('}', start) + 1)
}

describe('one scrollbar definition', () => {
  it('styles native scrollbars only in the app stylesheet and the SDK panel stylesheet', () => {
    const offenders = sources.filter(
      (file) => !SHARED.includes(file) && read(file).includes('::-webkit-scrollbar'),
    )
    expect(offenders).toEqual([])
  })

  it('never sets the standard scrollbar properties that switch the shared rule off', () => {
    const offenders = sources.filter((file) =>
      /scrollbar-color|scrollbar-width:\s*(thin|auto)/.test(read(file)),
    )
    expect(offenders).toEqual([])
  })

  it.each(SHARED)(
    '%s hides the arrow buttons and keeps the thumb hidden outside scrolling',
    (file) => {
      const css = read(file)
      expect(ruleBody(css, '::-webkit-scrollbar-button')).toContain('display: none')
      expect(ruleBody(css, '::-webkit-scrollbar-thumb')).toContain('background: transparent')
      expect(ruleBody(css, '[data-scrolling]::-webkit-scrollbar-thumb')).toContain(
        'background: var(--scrollbar-thumb)',
      )
    },
  )

  it.each(SHARED)('%s uses the shared size', (file) => {
    expect(read(file)).toContain(`--scrollbar-size: ${SCROLLBAR_SIZE_PX}px;`)
  })

  it('both stylesheets draw the same track, thumb and scrolling thumb', () => {
    const [app, panel] = SHARED.map(read)
    for (const selector of [
      '::-webkit-scrollbar',
      '::-webkit-scrollbar-button',
      '::-webkit-scrollbar-thumb',
      '[data-scrolling]::-webkit-scrollbar-thumb',
      '[data-scrolling]::-webkit-scrollbar-thumb:hover',
    ]) {
      expect(ruleBody(app, selector)).not.toBe('')
      expect(ruleBody(app, selector)).toBe(ruleBody(panel, selector))
    }
  })

  it('every Monaco editor takes its scrollbar options from the shared module', () => {
    const creators = sources.filter((file) =>
      /monaco\.editor\.(create|createDiffEditor)\(/.test(read(file)),
    )
    expect(creators.length).toBeGreaterThan(0)
    for (const file of creators) expect(read(file)).toContain('scrollbar: EDITOR_SCROLLBAR')
    const literals = sources.filter(
      (file) =>
        file !== 'src/renderer/lib/monaco/scrollbarOptions.ts' &&
        /ScrollbarSize|HasArrows/.test(read(file)),
    )
    expect(literals).toEqual([])
  })
})
