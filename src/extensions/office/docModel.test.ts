import { readFileSync } from 'node:fs'
import { translatorFor } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  docx,
  encryptedWorkbook,
  externalRelationship,
  paragraph,
  picture,
  retyped,
  workbook,
} from '../../../test/fixtures/office/workbooks'
import { readDocument } from './docModel'
import en from './locales/en.json'
import { OFFICE_LIMITS } from './officeLimits'
import { outlineWords } from './outlineHtml'

const WORDS = outlineWords(translatorFor({ en: en.messages }, 'en'))

const MIB = 1024 * 1024

afterEach(() => {
  vi.restoreAllMocks()
})

async function html(bytes: Uint8Array): Promise<string> {
  const result = await readDocument(bytes, OFFICE_LIMITS, WORDS)
  if (!result.ok) throw new Error(`not read: ${result.problem}`)
  return result.html
}

function wordFile(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`../../../test/fixtures/office/doc/${name}`, import.meta.url)),
  )
}

describe('readDocument (doc)', () => {
  it('reads the text of a Word 97-2003 file as paragraphs', async () => {
    const out = await html(wordFile('test01.doc'))
    expect(out).toContain('<p>A second test of reviewing')
    const table = await html(wordFile('test03.doc'))
    expect(table).toContain('Each license name is hyperlinked')
  })

  it('cuts the text at the outline limit and says so', async () => {
    const result = await readDocument(
      wordFile('test02.doc'),
      { ...OFFICE_LIMITS, outlineChars: 100 },
      WORDS,
    )
    expect(result.ok && result.textCut).toBe(true)
  })

  it('names a damaged Word file and a compound file that is no Word document', async () => {
    const failed = { ok: false, problem: 'failed' }
    expect(await readDocument(wordFile('badfile-01-bad-header.doc'), OFFICE_LIMITS, WORDS)).toEqual(
      failed,
    )
    const sheet = workbook({ S: [['x']] }, 'biff8')
    expect(await readDocument(sheet, OFFICE_LIMITS, WORDS)).toEqual(failed)
  })
})

describe('readDocument', () => {
  it('turns paragraphs into HTML and keeps markup in the text as text', async () => {
    const out = await html(
      docx({
        body: paragraph('Quarterly plan') + paragraph('&lt;script&gt;alert(1)&lt;/script&gt;'),
      }),
    )
    expect(out).toContain('<p>Quarterly plan</p>')
    expect(out).toContain('&lt;script&gt;')
    expect(out).not.toContain('<script')
  })

  it('opens docm, dotx and dotm like docx', async () => {
    const base = docx({ body: paragraph('shared') })
    const main = 'document.main+xml'
    const variants = {
      docm: retyped(base, main, 'document.macroEnabled.main+xml'),
      dotx: retyped(base, main, 'template.main+xml'),
      dotm: retyped(base, main, 'template.macroEnabled.main+xml'),
    }
    for (const [type, bytes] of Object.entries(variants)) {
      expect(await html(bytes), type).toContain('shared')
    }
  })

  it('embeds pictures inside the file and never fetches linked ones or link targets', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const result = await readDocument(
      docx({
        body: `${
          picture('r:embed', 'rPng', 'inside') + picture('r:link', 'rFar', 'outside')
        }<w:p><w:hyperlink r:id="rSite"><w:r><w:t>site</w:t></w:r></w:hyperlink></w:p>`,
        relationships:
          externalRelationship('rFar', 'image', 'http://127.0.0.1:9/far.png') +
          externalRelationship('rSite', 'hyperlink', 'http://127.0.0.1:9/page'),
      }),
      OFFICE_LIMITS,
      WORDS,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.html).toMatch(/<img [^>]*src="data:image\/png;base64,/)
    expect(result.html).not.toContain('far.png')
    expect(result.html).toContain('http://127.0.0.1:9/page')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('names the problem for a password and a malformed file', async () => {
    expect(await readDocument(encryptedWorkbook(), OFFICE_LIMITS, WORDS)).toEqual({
      ok: false,
      problem: 'encrypted',
    })
    expect(
      await readDocument(new TextEncoder().encode('not a document'), OFFICE_LIMITS, WORDS),
    ).toEqual({
      ok: false,
      problem: 'failed',
    })
  })

  it('ends a billion-laughs document quickly without expanding it', async () => {
    const levels = Array.from({ length: 9 }, (_unused, i) =>
      i === 0 ? '<!ENTITY l0 "laughlaugh">' : `<!ENTITY l${i} "${`&l${i - 1};`.repeat(10)}">`,
    ).join('')
    const started = Date.now()
    const result = await readDocument(
      docx({ doctype: `<!DOCTYPE w:document [${levels}]>`, body: paragraph('&l8;') }),
      OFFICE_LIMITS,
      WORDS,
    )
    expect(Date.now() - started).toBeLessThan(10_000)
    if (result.ok) expect(result.html.length).toBeLessThan(MIB)
  })
})
