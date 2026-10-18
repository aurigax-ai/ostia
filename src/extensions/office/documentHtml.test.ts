import createDOMPurify from 'dompurify'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { sanitizeDocument } from './documentHtml'

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
})
