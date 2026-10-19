import { translatorFor } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  docx,
  encryptedWorkbook,
  externalRelationship,
  paragraph,
  picture,
  retyped,
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
