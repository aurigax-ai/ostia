import { describe, expect, it } from 'vitest'
import { PRODUCT_DISPLAY_NAME } from '../../shared/productDisplay'
import { en, withProductName, zhHant } from './dict'

type Strings = { [key: string]: string | Strings }

function entries(strings: Strings, path = ''): [string, string][] {
  return Object.entries(strings).flatMap(([key, value]) => {
    const at = path ? `${path}.${key}` : key
    return typeof value === 'string' ? [[at, value] as [string, string]] : entries(value, at)
  })
}

const IDENTIFIERS = [
  'the pine command',
  'pine settings set',
  'pine view schema',
  'pine ask',
  'pine <agent>',
  'pine <name>',
  'pine <名稱>',
  'pine 指令',
]

function withoutIdentifiers(text: string): string {
  return IDENTIFIERS.reduce((rest, identifier) => rest.split(identifier).join(''), text)
}

function placeholders(text: string): string[] {
  return [...new Set(text.match(/\{\w+\}/g) ?? [])].sort()
}

describe('withProductName', () => {
  it('replaces every {product} placeholder', () => {
    expect(withProductName('While {product} is focused, {product} polls', 'Pine')).toBe(
      'While Pine is focused, Pine polls',
    )
  })

  it('uses the product name by default and leaves other text alone', () => {
    expect(withProductName('{product}')).toBe(PRODUCT_DISPLAY_NAME)
    expect(withProductName('No braces {here}')).toBe('No braces {here}')
  })
})

describe('product name in the dictionary', () => {
  const catalogs: [string, Strings][] = [
    ['en', en as unknown as Strings],
    ['zhHant', zhHant as unknown as Strings],
  ]

  it.each(catalogs)('%s never spells the product name: it writes {product}', (_name, catalog) => {
    const hardcoded = entries(catalog)
      .filter(([, text]) => /pine/i.test(withoutIdentifiers(text)))
      .map(([path, text]) => `${path}: ${text}`)

    expect(hardcoded).toEqual([])
  })

  it('still names the CLI where a string tells the human what to type', () => {
    const used = IDENTIFIERS.filter((identifier) =>
      catalogs.some(([, catalog]) =>
        entries(catalog).some(([, text]) => text.includes(identifier)),
      ),
    )

    expect(used).toEqual(IDENTIFIERS)
  })
})

describe('zhHant', () => {
  it('fills the same placeholders as English in every string', () => {
    const english = new Map(entries(en as unknown as Strings))
    const different = entries(zhHant as unknown as Strings)
      .filter(([path, text]) => {
        const base = english.get(path)
        return base !== undefined && placeholders(base).join() !== placeholders(text).join()
      })
      .map(([path]) => path)

    expect(different).toEqual([])
  })
})
