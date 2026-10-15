import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  docx,
  encryptedWorkbook,
  externalRelationship,
  paragraph,
  picture,
  withEntries,
  zeros,
} from '../../../test/fixtures/office/workbooks'
import { readDocument } from './docModel'
import { OFFICE_LIMITS } from './officeLimits'

const MIB = 1024 * 1024

afterEach(() => {
  vi.restoreAllMocks()
})

async function html(bytes: Uint8Array): Promise<string> {
  const result = await readDocument(bytes, OFFICE_LIMITS)
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
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.html).toMatch(/<img [^>]*src="data:image\/png;base64,/)
    expect(result.html).not.toContain('far.png')
    expect(result.html).toContain('http://127.0.0.1:9/page')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('names the problem for a bomb, a password, a large file and a malformed file', async () => {
    const plain = docx({ body: paragraph('x') })
    expect(
      await readDocument(withEntries(plain, zeros('word/media/b.bin', 129 * MIB)), OFFICE_LIMITS),
    ).toEqual({ ok: false, problem: 'unzip-limit' })
    expect(await readDocument(encryptedWorkbook(), OFFICE_LIMITS)).toEqual({
      ok: false,
      problem: 'encrypted',
    })
    expect(await readDocument(plain, { ...OFFICE_LIMITS, fileBytes: 100 })).toEqual({
      ok: false,
      problem: 'too-large',
    })
    expect(await readDocument(new TextEncoder().encode('not a document'), OFFICE_LIMITS)).toEqual({
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
    )
    expect(Date.now() - started).toBeLessThan(10_000)
    if (result.ok) expect(result.html.length).toBeLessThan(MIB)
  })
})
