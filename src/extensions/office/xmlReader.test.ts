import { describe, expect, it } from 'vitest'
import { childOf, childrenOf, pathOf, readXml, type XmlElement } from './xmlReader'

const DEPTH = 256

function read(text: string, depth = DEPTH): XmlElement {
  return readXml(text, depth)
}

function texts(element: XmlElement | undefined): string {
  return (element?.children ?? []).filter((node) => typeof node === 'string').join('')
}

describe('readXml', () => {
  it('reads elements, attributes and text, skipping the declaration, comments and a BOM', () => {
    const root = read(
      '\uFEFF<?xml version="1.0"?><!-- c --><a x="1" y=\'two\'><b/>t<c>u</c><![CDATA[<raw>]]></a>',
    )
    expect(root.name).toBe('a')
    expect(root.attributes.get('x')).toBe('1')
    expect(root.attributes.get('y')).toBe('two')
    expect(childrenOf(root, 'b')).toHaveLength(1)
    expect(texts(childOf(root, 'c'))).toBe('u')
    expect(texts(root)).toBe('t<raw>')
  })

  it('decodes the five predefined entities and numeric references, and replaces bad ones', () => {
    const root = read('<a v="&lt;&amp;&#65;">&gt;&quot;&apos;&#x4E2D;&#0;&#xD800;&#1114112;</a>')
    expect(root.attributes.get('v')).toBe('<&A')
    expect(texts(root)).toBe('>"\'中\uFFFD\uFFFD\uFFFD')
  })

  it('names elements and attributes by their namespace, whatever prefix the file uses', () => {
    const root = read(
      '<x:sld xmlns:x="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:q="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:cSld q:id="r1" plain="p"/><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/><u:odd xmlns:u="urn:other"/></x:sld>',
    )
    expect(root.name).toBe('p:sld')
    const slide = childOf(root, 'p:cSld')
    expect(slide?.attributes.get('r:id')).toBe('r1')
    expect(slide?.attributes.get('plain')).toBe('p')
    expect(childOf(root, 'ct:Types')).toBeDefined()
    expect(childOf(root, 'u:odd')).toBeDefined()
    expect(pathOf(root, 'p:cSld')).toBe(slide)
  })

  it('scopes a namespace to the element that declares it and its children only', () => {
    const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
    const root = read(
      `<a xmlns:x="${P}"><b xmlns:x="urn:other"><x:c/></b><x:d><e xmlns:y="urn:y"/><x:f/></x:d></a>`,
    )
    expect(childOf(childOf(root, 'b'), 'x:c')).toBeDefined()
    const d = childOf(root, 'p:d')
    expect(d).toBeDefined()
    expect(childOf(d, 'p:f')).toBeDefined()
  })

  it.each([
    ['a doctype', '<!DOCTYPE a><a/>'],
    ['an entity declaration', '<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>'],
    ['an internal declaration', '<a><!ELEMENT a ANY></a>'],
    ['an undeclared entity', '<a>&e;</a>'],
    ['a bare ampersand', '<a>fish & chips</a>'],
    ['an unclosed element', '<a><b></a>'],
    ['a mismatched end tag', '<a></b>'],
    ['a second root', '<a/><b/>'],
    ['text outside the root', '<a/>tail'],
    ['an unquoted attribute', '<a x=1/>'],
    ['an attribute with no value', '<a x/>'],
    ['a < inside an attribute', '<a x="<"/>'],
    ['an unfinished comment', '<a><!-- x</a>'],
    ['nothing at all', '   '],
  ])('refuses %s', (_case, text) => {
    expect(() => read(text)).toThrow('failed')
  })

  it('refuses a billion-laughs document at once without expanding it', () => {
    const levels = Array.from({ length: 9 }, (_unused, i) =>
      i === 0 ? '<!ENTITY l0 "laughlaugh">' : `<!ENTITY l${i} "${`&l${i - 1};`.repeat(10)}">`,
    ).join('')
    const started = Date.now()
    expect(() => read(`<?xml version="1.0"?><!DOCTYPE a [${levels}]><a>&l8;</a>`)).toThrow('failed')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('stops nesting past the depth limit with its own reason and no stack overflow', () => {
    const deep = (levels: number): string => `${'<d>'.repeat(levels)}${'</d>'.repeat(levels)}`
    expect(read(deep(8), 8).name).toBe('d')
    expect(() => read(deep(9), 8)).toThrow('failed')
    expect(() => read(deep(50_000))).toThrow('failed')
  })
})
