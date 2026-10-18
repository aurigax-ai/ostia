import { translatorFor } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import createDOMPurify from 'dompurify'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  para,
  picture,
  pptx,
  relationship,
  run,
  shape,
  titleShape,
} from '../../../test/fixtures/office/presentations'
import { sanitizeDocument } from './documentHtml'
import en from './locales/en.json'
import { OFFICE_LIMITS } from './officeLimits'
import { outlineWords } from './outlineHtml'
import { readPresentation } from './presentationModel'

const { window } = new JSDOM('')
const purify = createDOMPurify(window as unknown as Window & typeof globalThis)

function clean(html: string): string {
  const holder = window.document.createElement('div')
  holder.append(sanitizeDocument(html, purify))
  return holder.innerHTML
}

describe('sanitizeDocument', () => {
  it('keeps the document structure', () => {
    expect(
      clean(
        '<h1>T</h1><p><strong>b</strong> <em>i</em></p><table><tr><td colspan="2">c</td></tr></table>',
      ),
    ).toBe(
      '<h1>T</h1><p><strong>b</strong> <em>i</em></p><table><tbody><tr><td colspan="2">c</td></tr></tbody></table>',
    )
  })

  it('keeps the slide sections of a presentation outline', () => {
    const outline =
      '<section><h2>Plan</h2><ul><li>a</li></ul><blockquote><h3>Notes</h3><p>n</p></blockquote></section>'
    expect(clean(outline)).toBe(outline)
  })

  it('removes scripts, handlers, styles, frames and forms', () => {
    const out = clean(
      '<p onclick="x()" style="color:red" class="c">p</p><script>alert(1)</script><iframe src="x"></iframe><form><input></form><svg><circle/></svg><math></math>',
    )
    expect(out).toBe('<p>p</p>')
  })

  it('keeps only embedded raster images and makes links inert with their address as a hint', () => {
    const out = clean(
      [
        '<img src="data:image/png;base64,AAAA" alt="ok">',
        '<img src="http://127.0.0.1:9/x.png">',
        '<img src="data:image/svg+xml;base64,PHN2Zz4=">',
        '<img src="file:///etc/passwd">',
        '<a href="javascript:alert(1)">js</a>',
        '<a href="https://example.com/page">site</a>',
      ].join(''),
    )
    expect(out).toBe(
      '<img src="data:image/png;base64,AAAA" alt="ok"><a>js</a><a title="https://example.com/page">site</a>',
    )
  })

  it('leaves a presentation outline with no address an element could load or follow', () => {
    const deck = pptx({
      slides: [
        {
          shapes: titleShape('T') + shape(para(run('site', 'rWeb'))) + picture('Logo'),
          relationships:
            relationship('rImg', 'image', 'http://127.0.0.1:9/far.png', true) +
            relationship('rWeb', 'hyperlink', 'http://127.0.0.1:9/page', true),
        },
      ],
    })
    const result = readPresentation(
      deck,
      OFFICE_LIMITS,
      outlineWords(translatorFor({ en: en.messages }, 'en')),
    )
    if (!result.ok) throw new Error(`not read: ${result.problem}`)
    const holder = window.document.createElement('div')
    holder.append(sanitizeDocument(result.html, purify))
    expect(holder.querySelectorAll('a[href], img, [src]')).toHaveLength(0)
    expect(holder.querySelector('a')?.title).toBe('http://127.0.0.1:9/page')
    expect(holder.textContent).toContain('[Image: Logo]')
  })
})
