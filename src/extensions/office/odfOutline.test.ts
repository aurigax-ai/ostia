import { translatorFor } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import { strToU8 } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ODP_MIMETYPE,
  ODT_MIMETYPE,
  odf,
  odfContent,
  odpFrame,
  odpNotes,
  odpPage,
} from '../../../test/fixtures/office/presentations'
import { deflated } from '../../../test/fixtures/office/workbooks'
import { type DocumentResult, readDocument } from './docModel'
import en from './locales/en.json'
import { OFFICE_LIMITS, type OfficeLimits } from './officeLimits'
import { outlineWords } from './outlineHtml'
import { readPresentation } from './presentationModel'

const WORDS = outlineWords(translatorFor({ en: en.messages }, 'en'))

afterEach(() => {
  vi.restoreAllMocks()
})

function html(result: DocumentResult): string {
  if (!result.ok) throw new Error(`not read: ${result.problem}`)
  return result.html
}

function text(bytes: Uint8Array, limits: OfficeLimits = OFFICE_LIMITS): Promise<DocumentResult> {
  return readDocument(bytes, limits, WORDS)
}

function slides(bytes: Uint8Array, limits: OfficeLimits = OFFICE_LIMITS): DocumentResult {
  return readPresentation(bytes, limits, WORDS)
}

describe('readDocument (odt)', () => {
  it('reads headings, spans, spaces, tabs, line breaks and nested lists', async () => {
    const out = html(
      await text(
        odf(ODT_MIMETYPE, {
          body: [
            '<text:sequence-decls><text:sequence-decl text:name="x"/></text:sequence-decls>',
            '<text:h text:outline-level="2">Heading</text:h>',
            '<text:p>a<text:span>b</text:span><text:s text:c="2"/>c<text:tab/>d<text:line-break/>e\n   f</text:p>',
            '<text:list><text:list-item><text:p>one</text:p><text:list><text:list-item><text:p>two</text:p></text:list-item></text:list></text:list-item></text:list>',
            '<text:p/>',
          ].join(''),
        }),
      ),
    )
    expect(out).toBe(
      '<h2>Heading</h2><p>ab\u00a0\u00a0c\td<br>e f</p><ul><li>one<ul><li>two</li></ul></li></ul>',
    )
  })

  it('keeps merged table cells as spans and leaves out covered ones', async () => {
    const out = html(
      await text(
        odf(ODT_MIMETYPE, {
          body: `<table:table><table:table-column/><table:table-header-rows><table:table-row><table:table-cell table:number-columns-spanned="2"><text:p>wide</text:p></table:table-cell><table:covered-table-cell/></table:table-row></table:table-header-rows><table:table-row><table:table-cell table:number-rows-spanned="2"><text:p>tall</text:p></table:table-cell><table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table>`,
        }),
      ),
    )
    expect(out).toBe(
      '<table><tbody><tr><td colspan="2"><p>wide</p></td></tr><tr><td rowspan="2"><p>tall</p></td><td><p>b</p></td></tr></tbody></table>',
    )
  })

  it('names images without fetching them, links only web addresses and skips comments and tracked changes', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const out = html(
      await text(
        odf(ODT_MIMETYPE, {
          body: [
            '<text:tracked-changes><text:changed-region><text:deletion><text:p>removed</text:p></text:deletion></text:changed-region></text:tracked-changes>',
            '<text:p>see <draw:frame><svg:title>Logo</svg:title><draw:image xlink:href="https://127.0.0.1:9/far.png"/></draw:frame></text:p>',
            '<text:p><text:a xlink:href="https://example.com/">site</text:a> <text:a xlink:href="javascript:alert(1)">js</text:a><office:annotation><text:p>comment</text:p></office:annotation></text:p>',
          ].join(''),
        }),
      ),
    )
    expect(out).toBe('<p>see [Image: Logo]</p><p><a href="https://example.com/">site</a> js</p>')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads a document-content with no body or no text as empty, and refuses a wrong root', async () => {
    for (const inner of [
      '',
      '<office:body/>',
      '<office:body><office:spreadsheet/></office:body>',
    ]) {
      expect(html(await text(odf(ODT_MIMETYPE, { body: '', content: odfContent(inner) })))).toBe('')
    }
    const wrong = odf(ODT_MIMETYPE, { body: '', content: '<office:document-styles/>' })
    expect(await text(wrong)).toEqual({ ok: false, problem: 'failed' })
    const blank = odf(ODT_MIMETYPE, { body: '', content: '' })
    expect(await text(blank)).toEqual({ ok: false, problem: 'failed' })
  })

  it('refuses a doctype, a password and a mismatched end tag, and names a deep nest', async () => {
    const doctype = odf(ODT_MIMETYPE, {
      body: '',
      content: `<!DOCTYPE office:document-content [<!ENTITY e "x">]>${odfContent('')}`,
    })
    expect(await text(doctype)).toEqual({ ok: false, problem: 'failed' })
    const locked = odf(ODT_MIMETYPE, {
      body: '<text:p>x</text:p>',
      manifest:
        '<manifest:file-entry manifest:full-path="content.xml"><manifest:encryption-data/></manifest:file-entry>',
    })
    expect(await text(locked)).toEqual({ ok: false, problem: 'encrypted' })
    const broken = odf(ODT_MIMETYPE, { body: '<text:p>x</text:span>' })
    expect(await text(broken)).toEqual({ ok: false, problem: 'failed' })
    const deep = odf(ODT_MIMETYPE, {
      body: `${'<text:section>'.repeat(40)}${'</text:section>'.repeat(40)}`,
    })
    expect(await text(deep, { ...OFFICE_LIMITS, xmlDepth: 32 })).toEqual({
      ok: false,
      problem: 'depth-limit',
    })
  })

  it('refuses more elements than documentNodes allows', async () => {
    const many = odf(ODT_MIMETYPE, { body: '<text:p>x</text:p>'.repeat(300) })
    expect(await text(many, { ...OFFICE_LIMITS, documentNodes: 200 })).toEqual({
      ok: false,
      problem: 'nodes-limit',
    })
  })

  it('judges by content, not by name: a presentation is not a text document', async () => {
    const deck = odf(ODP_MIMETYPE, { body: odpPage('p1', '') })
    expect(await text(deck)).toEqual({ ok: false, problem: 'failed' })
    expect(slides(odf(ODT_MIMETYPE, { body: '<text:p>x</text:p>' }))).toEqual({
      ok: false,
      problem: 'failed',
    })
  })
})

describe('readPresentation (odp)', () => {
  it('lists pages in order with titles, text, notes and hidden pages', () => {
    const out = html(
      slides(
        odf(ODP_MIMETYPE, {
          styles:
            '<style:style style:name="dp2" style:family="drawing-page"><style:drawing-page-properties presentation:visibility="hidden"/></style:style>',
          body: [
            odpPage(
              'page1',
              odpFrame('title', '<text:p>Opening</text:p>') +
                odpFrame(
                  'outline',
                  '<text:list><text:list-item><text:p>point</text:p></text:list-item></text:list>',
                ) +
                odpFrame('page-number', '<text:p>1</text:p>') +
                odpNotes('say hello'),
            ),
            odpPage(
              'Backup',
              '<draw:custom-shape><text:p>shape text</text:p></draw:custom-shape>',
              'draw:style-name="dp2"',
            ),
            odpPage('', ''),
          ].join(''),
        }),
      ),
    )
    expect(out).toBe(
      [
        '<section><h2>Opening</h2><ul><li>point</li></ul><blockquote><h3>Notes</h3><p>say hello</p></blockquote></section>',
        '<section><h2>Backup (hidden)</h2><p>shape text</p></section>',
        '<section><h2>Slide 3</h2></section>',
      ].join(''),
    )
  })

  it('names images and objects, links web addresses and never runs Basic', () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const out = html(
      slides(
        odf(ODP_MIMETYPE, {
          body: odpPage(
            'p',
            [
              '<draw:frame><draw:image xlink:href="Pictures/a.png"><text:p/></draw:image><svg:desc>Chart of sales</svg:desc></draw:frame>',
              '<draw:frame><draw:object xlink:href="./Object 1"/></draw:frame>',
              odpFrame(
                '',
                '<text:p><text:a xlink:href="https://example.com/">site</text:a></text:p>',
              ),
            ].join(''),
          ),
          extra: [deflated('Basic/Standard/Module1.xml', strToU8('<script>Sub Main</script>'))],
        }),
      ),
    )
    expect(out).toBe(
      '<section><h2>p</h2><p>[Image: Chart of sales]</p><p>[Embedded object]</p><p><a href="https://example.com/">site</a></p></section>',
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads an empty presentation as no slides and cuts past the slide limit', () => {
    expect(html(slides(odf(ODP_MIMETYPE, { body: '' })))).toBe('')
    const three = odf(ODP_MIMETYPE, {
      body: odpPage('a', '') + odpPage('b', '') + odpPage('c', ''),
    })
    const result = slides(three, { ...OFFICE_LIMITS, slides: 2 })
    expect(result.ok && result.slidesCut).toBe(2)
    expect(html(result)).not.toContain('<h2>c</h2>')
  })

  it('refuses a password and more elements than presentationNodes allows', () => {
    const locked = odf(ODP_MIMETYPE, {
      body: odpPage('p', ''),
      manifest: '<manifest:file-entry><manifest:encryption-data/></manifest:file-entry>',
    })
    expect(slides(locked)).toEqual({ ok: false, problem: 'encrypted' })
    const many = odf(ODP_MIMETYPE, { body: odpPage('p', '<text:p>x</text:p>'.repeat(300)) })
    expect(slides(many, { ...OFFICE_LIMITS, presentationNodes: 200 })).toEqual({
      ok: false,
      problem: 'nodes-limit',
    })
  })
})
