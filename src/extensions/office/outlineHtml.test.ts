import { translatorFor } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'
import {
  type Block,
  documentOutlineHtml,
  outlineWords,
  presentationOutlineHtml,
  type Slide,
} from './outlineHtml'

const WORDS = outlineWords(translatorFor({ en: en.messages }, 'en'))
const MAX = 1_000_000

function doc(blocks: Block[], max = MAX): string {
  return documentOutlineHtml(blocks, WORDS, max).html
}

function slide(partial: Partial<Slide>): Slide {
  return { number: 1, title: '', hidden: false, blocks: [], notes: [], ...partial }
}

describe('documentOutlineHtml', () => {
  it('escapes text and turns line breaks into br', () => {
    expect(doc([{ type: 'p', runs: [{ text: '<script>"a" & \'b\'</script>\nnext' }] }])).toBe(
      '<p>&lt;script&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/script&gt;<br>next</p>',
    )
  })

  it('nests list items by level and never skips a level', () => {
    const li = (text: string, level: number, ordered = false): Block => ({
      type: 'li',
      level,
      ordered,
      runs: [{ text }],
    })
    expect(doc([li('a', 0), li('b', 3), li('c', 1), li('d', 0), li('e', 0, true)])).toBe(
      '<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li><li>e</li></ul>',
    )
    expect(doc([li('a', 0, true), { type: 'p', runs: [{ text: 'p' }] }, li('b', 0)])).toBe(
      '<ol><li>a</li></ol><p>p</p><ul><li>b</li></ul>',
    )
  })

  it('writes merged cells as colspan and rowspan, clamped, and nothing for a span of one', () => {
    const cell = (text: string, colspan = 1, rowspan = 1) => ({
      blocks: [{ type: 'p' as const, runs: [{ text }] }],
      colspan,
      rowspan,
    })
    expect(doc([{ type: 'table', rows: [[cell('a', 2, 3), cell('b', 1e9, -4)]] }])).toBe(
      '<table><tbody><tr><td colspan="2" rowspan="3"><p>a</p></td><td colspan="1000"><p>b</p></td></tr></tbody></table>',
    )
  })

  it('links only http(s) and mailto, and names figures without reading them', () => {
    expect(
      doc([
        {
          type: 'p',
          runs: [
            { text: 'site', href: 'https://example.com/?a="1"' },
            { text: 'js', href: 'javascript:alert(1)' },
            { text: 'mail', href: 'mailto:a@example.com' },
            { figure: { kind: 'image', alt: 'A <cat>' } },
            { figure: { kind: 'image', alt: '' } },
            { figure: { kind: 'chart', alt: '' } },
            { figure: { kind: 'object', alt: '' } },
          ],
        },
      ]),
    ).toBe(
      '<p><a href="https://example.com/?a=&quot;1&quot;">site</a>js<a href="mailto:a@example.com">mail</a>[Image: A &lt;cat&gt;][Image][Chart][Embedded object]</p>',
    )
  })

  it('stops at the text limit and says so', () => {
    const out = documentOutlineHtml(
      [
        { type: 'p', runs: [{ text: 'abcdef' }] },
        { type: 'p', runs: [{ text: 'never' }] },
      ],
      WORDS,
      7,
    )
    expect(out).toEqual({ html: '<p>abcd</p>', textCut: true })
    expect(documentOutlineHtml([], WORDS, 4)).toEqual({ html: '', textCut: false })
  })

  it('counts markup against the limit too, so content with no text is cut and stays closed', () => {
    const empty = { blocks: [], colspan: 1, rowspan: 1 }
    const rows = Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => empty))
    const out = documentOutlineHtml(
      [
        { type: 'table', rows },
        { type: 'p', runs: [{ text: 'never' }] },
      ],
      WORDS,
      200,
    )
    expect(out.textCut).toBe(true)
    expect(out.html.length).toBeLessThan(500)
    expect(out.html).toMatch(/^<table><tbody><tr>(?:<td><\/td>)+<\/tr><\/tbody><\/table>$/)
  })
})

describe('presentationOutlineHtml', () => {
  it('writes one section per slide, numbering untitled ones and marking hidden ones', () => {
    const out = presentationOutlineHtml(
      [
        slide({ title: 'Plan', blocks: [{ type: 'h', level: 1, runs: [{ text: 'h' }] }] }),
        slide({ number: 2, hidden: true }),
      ],
      WORDS,
      MAX,
    )
    expect(out.html).toBe(
      '<section><h2>Plan</h2><h3>h</h3></section><section><h2>Slide 2 (hidden)</h2></section>',
    )
  })

  it('puts notes under the slide, labelled', () => {
    const zh = outlineWords(
      translatorFor({ en: en.messages, 'zh-Hant': zhHant.messages }, 'zh-Hant'),
    )
    const out = presentationOutlineHtml(
      [slide({ title: 'T', notes: [{ type: 'p', runs: [{ text: 'say this' }] }] })],
      zh,
      MAX,
    )
    expect(out.html).toBe(
      '<section><h2>T</h2><blockquote><h3>備註</h3><p>say this</p></blockquote></section>',
    )
    expect(presentationOutlineHtml([slide({ hidden: true })], zh, MAX).html).toContain(
      '第 1 張投影片（隱藏）',
    )
  })
})
