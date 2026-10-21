import { translatorFor } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import { strToU8 } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cell,
  PPSX_TYPE,
  PPTM_TYPE,
  para,
  picture,
  pptx,
  relationship,
  run,
  shape,
  TEMPLATE_TYPES,
  table,
  titleShape,
} from '../../../test/fixtures/office/presentations'
import {
  deflated,
  docx,
  encryptedWorkbook,
  paragraph,
} from '../../../test/fixtures/office/workbooks'
import en from './locales/en.json'
import { OFFICE_LIMITS, type OfficeLimits } from './officeLimits'
import { outlineWords } from './outlineHtml'
import { partKey } from './pptxOutline'
import { readPresentation } from './presentationModel'

const WORDS = outlineWords(translatorFor({ en: en.messages }, 'en'))
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'

afterEach(() => {
  vi.restoreAllMocks()
})

function html(bytes: Uint8Array, limits: OfficeLimits = OFFICE_LIMITS): string {
  const result = readPresentation(bytes, limits, WORDS)
  if (!result.ok) throw new Error(`not read: ${result.problem}`)
  return result.html
}

function problem(bytes: Uint8Array, limits: OfficeLimits = OFFICE_LIMITS): string | null {
  const result = readPresentation(bytes, limits, WORDS)
  return result.ok ? null : result.problem
}

describe('partKey', () => {
  it('resolves a target against its part and never climbs out of the package', () => {
    expect(partKey('ppt/slides/slide1.xml', '../notesSlides/notesSlide1.xml')).toBe(
      'ppt/notesslides/notesslide1.xml',
    )
    expect(partKey('ppt/presentation.xml', 'slides/./slide2.xml')).toBe('ppt/slides/slide2.xml')
    expect(partKey('ppt/slides/slide1.xml', '/ppt/slides/slide3.xml')).toBe('ppt/slides/slide3.xml')
    expect(partKey('ppt/presentation.xml', '../../etc/passwd')).toBeNull()
  })
})

describe('readPresentation (pptx)', () => {
  it('lists slides in sldIdLst order with titles, levelled bullets, text boxes and notes', () => {
    const out = html(
      pptx({
        slides: [
          {
            shapes:
              titleShape('First') +
              shape(para(run('point')) + para(run('detail'), '<a:pPr lvl="1"/>'), '') +
              shape(para(run('free text'))) +
              shape(para(run('Page 7')), 'sldNum'),
            notes: 'speaker words',
          },
          {
            shapes: `${titleShape('Second')}<p:grpSp><p:nvGrpSpPr/><p:grpSpPr/>${shape(para(run('grouped')))}</p:grpSp>`,
            show: '0',
          },
        ],
        order: [1, 0],
      }),
    )
    expect(out).toBe(
      [
        '<section><h2>Second (hidden)</h2><p>grouped</p></section>',
        '<section><h2>First</h2><ul><li>point<ul><li>detail</li></ul></li></ul><p>free text</p>',
        '<blockquote><h3>Notes</h3><p>speaker words</p></blockquote></section>',
      ].join(''),
    )
  })

  it('numbers an untitled slide and shows a slide that has only a title', () => {
    const out = html(pptx({ slides: [{ shapes: titleShape('Only a title') }, { shapes: '' }] }))
    expect(out).toBe('<section><h2>Only a title</h2></section><section><h2>Slide 2</h2></section>')
  })

  it('keeps merged table cells as spans and drops the cells they cover', () => {
    const out = html(
      pptx({
        slides: [
          {
            shapes: table([
              [cell('wide', 'gridSpan="2"'), cell('', 'hMerge="1"'), cell('tall', 'rowSpan="2"')],
              [cell('a'), cell('b'), cell('', 'vMerge="1"')],
            ]),
          },
        ],
      }),
    )
    expect(out).toContain(
      '<table><tbody><tr><td colspan="2"><p>wide</p></td><td rowspan="2"><p>tall</p></td></tr><tr><td><p>a</p></td><td><p>b</p></td></tr></tbody></table>',
    )
  })

  it('names pictures and charts, and links only external web addresses, fetching nothing', () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const chart = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="C"/></p:nvGraphicFramePr><a:graphic><a:graphicData uri="c"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rC"/></a:graphicData></a:graphic></p:graphicFrame>`
    const out = html(
      pptx({
        slides: [
          {
            shapes:
              picture('A cat') +
              chart +
              shape(para(run('site', 'rWeb') + run('script', 'rJs') + run('next', 'rNext'))),
            relationships:
              relationship('rImg', 'image', 'http://127.0.0.1:9/far.png', true) +
              relationship('rWeb', 'hyperlink', 'https://example.com/', true) +
              relationship('rJs', 'hyperlink', 'javascript:alert(1)', true) +
              relationship('rNext', 'slide', 'slide1.xml'),
          },
        ],
      }),
    )
    expect(out).toContain('<p>[Image: A cat]</p><p>[Chart]</p>')
    expect(out).toContain('<p><a href="https://example.com/">site</a>scriptnext</p>')
    expect(out).not.toMatch(/src=|far\.png|javascript/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shows markup in the text as text', () => {
    expect(html(pptx({ slides: [{ shapes: titleShape('&lt;script&gt;x&lt;/script&gt;') }] }))).toBe(
      '<section><h2>&lt;script&gt;x&lt;/script&gt;</h2></section>',
    )
  })

  it('reads an empty presentation as no slides', () => {
    expect(html(pptx({ slides: [] }))).toBe('')
  })

  it('skips slides whose relationship is missing, external, escapes the package or names an unread part', () => {
    const secret = `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree>${titleShape('secret')}</p:spTree></p:cSld></p:sld>`
    const bytes = pptx({
      slides: [{ shapes: titleShape('kept') }, { shapes: titleShape('never') }],
      order: [0, 2, 3, 4, 5],
      presentationRelationships:
        relationship('rS3', 'slide', 'slides/missing.xml') +
        relationship('rS4', 'slide', 'slides/slide2.xml', true) +
        relationship('rS5', 'slide', '../../ppt/slides/slide2.xml') +
        relationship('rS6', 'slide', 'media/secret.xml'),
      extra: [deflated('ppt/media/secret.xml', strToU8(secret))],
    })
    expect(html(bytes)).toBe('<section><h2>kept</h2></section>')
  })

  it('lists a slide named again only once and stops markup with no text at outlineChars', () => {
    const empty = Array.from({ length: 10 }, () => Array.from({ length: 100 }, () => cell('')))
    const bytes = pptx({ slides: [{ shapes: table(empty) }], order: Array(2_000).fill(0) })
    expect(bytes.length).toBeLessThan(1024 * 1024)
    const limits = { ...OFFICE_LIMITS, outlineChars: 2_000 }
    const result = readPresentation(bytes, limits, WORDS)
    if (!result.ok) throw new Error(`not read: ${result.problem}`)
    expect(result.html.match(/<section>/g)).toHaveLength(1)
    expect(result.textCut).toBe(true)
    expect(result.html.length).toBeLessThan(2.5 * limits.outlineChars)
    expect(result.html.endsWith('</tbody></table></section>')).toBe(true)
    const named = pptx({ slides: [{ shapes: titleShape('once') }], order: [0, 0, 0] })
    expect(html(named)).toBe('<section><h2>once</h2></section>')
  })

  it('shows notes that several slides point to only once', () => {
    const out = html(
      pptx({
        slides: [
          { shapes: titleShape('one'), notes: 'shared words' },
          {
            shapes: titleShape('two'),
            relationships: relationship('rN', 'notesSlide', '../notesSlides/notesSlide1.xml'),
          },
        ],
      }),
    )
    expect(out.match(/shared words/g)).toHaveLength(1)
    expect(out).toContain('<section><h2>two</h2></section>')
  })

  it('refuses a file whose content type is not a presentation, whatever its name', () => {
    expect(problem(docx({ body: paragraph('a word document') }))).toBe('failed')
    expect(
      problem(
        pptx({
          slides: [],
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
        }),
      ),
    ).toBe('failed')
    expect(problem(pptx({ slides: [], omit: ['ppt/presentation.xml'] }))).toBe('failed')
  })

  it('opens pptm, ppsx, ppsm, potx and potm, never reading the macro project', () => {
    const macro = deflated('ppt/vbaProject.bin', strToU8('<p:sld>Sub AutoOpen()</p:sld>'))
    for (const contentType of [PPTM_TYPE, PPSX_TYPE, ...TEMPLATE_TYPES]) {
      const out = html(
        pptx({ slides: [{ shapes: titleShape('show') }], contentType, extra: [macro] }),
      )
      expect(out).toBe('<section><h2>show</h2></section>')
    }
  })

  it('refuses a doctype at once without expanding it, and names a password', () => {
    const levels = Array.from({ length: 9 }, (_unused, i) =>
      i === 0 ? '<!ENTITY l0 "laughlaugh">' : `<!ENTITY l${i} "${`&l${i - 1};`.repeat(10)}">`,
    ).join('')
    const started = Date.now()
    const laughs = { shapes: titleShape('&l8;'), doctype: `<!DOCTYPE p:sld [${levels}]>` }
    expect(problem(pptx({ slides: [laughs] }))).toBe('failed')
    expect(Date.now() - started).toBeLessThan(1_000)
    const plain = { shapes: titleShape('x'), doctype: '<!DOCTYPE p:sld>' }
    expect(problem(pptx({ slides: [plain] }))).toBe('failed')
    expect(problem(encryptedWorkbook())).toBe('encrypted')
  })

  it('says why for nesting and cuts the slide count at its limit', () => {
    const deep = `${'<p:grpSp>'.repeat(40)}${'</p:grpSp>'.repeat(40)}`
    expect(problem(pptx({ slides: [{ shapes: deep }] }), { ...OFFICE_LIMITS, xmlDepth: 32 })).toBe(
      'failed',
    )
    const three = pptx({ slides: ['a', 'b', 'c'].map((text) => ({ shapes: titleShape(text) })) })
    const result = readPresentation(three, { ...OFFICE_LIMITS, slides: 2 }, WORDS)
    expect(result.ok && result.slidesCut).toBe(2)
    expect(result.ok && result.html).not.toContain('<h2>c</h2>')
  })
})
