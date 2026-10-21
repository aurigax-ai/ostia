import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseManifest } from '@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest'
import { describe, expect, it } from 'vitest'

const source = __dirname
const built = join(__dirname, '../../../out/extensions/pdf')

describe('the pdf extension', () => {
  it('claims *.pdf as the default view of kind pdf.pdf', () => {
    const parsed = parseManifest(
      JSON.parse(readFileSync(join(source, 'ostia.json'), 'utf8')),
      source,
    )
    if (!parsed.ok) throw new Error(parsed.error)
    const [kind] = parsed.manifest.contributes.fileKinds ?? []
    expect(kind.id).toBe('pdf.pdf')
    expect(kind.selector).toEqual([{ filenamePattern: '*.pdf' }])
    expect(kind.view).toEqual({ entry: 'pdf.html', priority: 'default' })
  })

  it('ships the page, its worker and the data pdf.js loads by URL as extension files', () => {
    for (const file of ['pdf.html', 'pdf.js', 'pdf.worker.js', 'base.css', 'assets/pdf.css']) {
      expect(existsSync(join(built, file)), file).toBe(true)
    }
    expect(readdirSync(join(built, 'cmaps')).length).toBeGreaterThan(10)
    expect(existsSync(join(built, 'standard_fonts/LiberationSans-Regular.ttf'))).toBe(true)
    expect(readdirSync(join(built, 'wasm')).some((name) => name.endsWith('.wasm'))).toBe(true)
  })

  it('bundles pdf.js into the page and never loads code from elsewhere', () => {
    const page = readFileSync(join(built, 'pdf.js'), 'utf8')
    expect(page).toContain('GlobalWorkerOptions')
    expect(readFileSync(join(built, 'pdf.html'), 'utf8')).not.toMatch(/https?:\/\//)
  })
})
