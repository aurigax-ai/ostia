import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { iconWeight, useIconStyle } from './iconWeight'

const renderer = resolve(process.cwd(), 'src/renderer')
const sources = readdirSync(renderer, { recursive: true, encoding: 'utf8' })
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
  .map((f) => ({ file: f, text: readFileSync(join(renderer, f), 'utf8') }))

describe('iconWeight', () => {
  it('keeps the regular weight only where its 1 px strokes land on whole device pixels', () => {
    expect(iconWeight(2)).toBe('regular')
    expect(iconWeight(4)).toBe('regular')
    expect(iconWeight(2.0000001)).toBe('regular')
  })

  it('uses the bold weight on 1x, fractional scales and app zoom other than 100%', () => {
    for (const ratio of [1, 1.25, 1.5, 1.75, 1.8, 2.2, 2.4, 3]) {
      expect(iconWeight(ratio)).toBe('bold')
    }
  })
})

describe('useIconStyle', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('follows a change of the device pixel ratio', () => {
    let onChange = (): void => {}
    vi.stubGlobal('devicePixelRatio', 2)
    vi.stubGlobal('matchMedia', (media: string) => ({
      media,
      matches: true,
      addEventListener: (_: string, listener: () => void) => {
        onChange = listener
      },
      removeEventListener: () => {},
    }))
    const { result } = renderHook(() => useIconStyle())
    expect(result.current).toEqual({ weight: 'regular' })

    vi.stubGlobal('devicePixelRatio', 1.5)
    act(() => onChange())

    expect(result.current).toEqual({ weight: 'bold' })
  })
})

describe('icon weight source', () => {
  it('comes from the one IconContext, in App', () => {
    const providers = sources.filter((s) => s.text.includes('IconContext.Provider'))
    expect(providers.map((s) => s.file)).toEqual(['App.tsx'])
  })

  it('is never set on a single Phosphor icon', () => {
    const overrides = sources.flatMap((s) =>
      [...s.text.matchAll(/<\w*Icon\b[^>]*\sweight=/g)].map(() => s.file),
    )
    expect(overrides).toEqual([])
  })
})
