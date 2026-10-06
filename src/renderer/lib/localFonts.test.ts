import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Query = () => Promise<{ family: string }[]>

function setQuery(query: Query | undefined): void {
  Object.defineProperty(window, 'queryLocalFonts', { value: query, configurable: true })
}

async function freshModule(): Promise<typeof import('./localFonts')> {
  vi.resetModules()
  return import('./localFonts')
}

describe('localFontFamilies', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'fonts', {
      value: [{ family: '"Inter"' }, { family: 'JetBrains Mono' }],
      configurable: true,
    })
  })

  afterEach(() => {
    setQuery(undefined)
    Reflect.deleteProperty(document, 'fonts')
  })

  it('lists the bundled and installed families, sorted and unique', async () => {
    setQuery(async () => [{ family: 'Fira Code' }, { family: 'Inter' }])
    const { localFontFamilies } = await freshModule()
    expect(await localFontFamilies()).toEqual(['Fira Code', 'Inter', 'JetBrains Mono'])
  })

  it('returns the bundled families when the query throws', async () => {
    setQuery(() => Promise.reject(new DOMException('no gesture', 'SecurityError')))
    const { localFontFamilies } = await freshModule()
    expect(await localFontFamilies()).toEqual(['Inter', 'JetBrains Mono'])
  })

  it('queries again after a failed load', async () => {
    const query = vi
      .fn<Query>()
      .mockRejectedValueOnce(new DOMException('no gesture', 'SecurityError'))
      .mockResolvedValue([{ family: 'Fira Code' }])
    setQuery(query)
    const { localFontFamilies } = await freshModule()
    await localFontFamilies()
    expect(await localFontFamilies()).toEqual(['Fira Code', 'Inter', 'JetBrains Mono'])
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('keeps a successful load', async () => {
    const query = vi.fn<Query>().mockResolvedValue([{ family: 'Fira Code' }])
    setQuery(query)
    const { localFontFamilies } = await freshModule()
    await localFontFamilies()
    await localFontFamilies()
    expect(query).toHaveBeenCalledTimes(1)
  })
})
