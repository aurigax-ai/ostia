import { readdirSync, readFileSync } from 'node:fs'
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

  it('is never drawn smaller than 16 px', () => {
    const tag = String.raw`<(?:\w*Icon\w*|Caret)\b[^>]*?`
    const smallProp = new RegExp(String.raw`${tag}\ssize=\{(?:[1-9]|1[0-5])\}`, 'g')
    const smallClass = new RegExp(String.raw`${tag}\bsize-(?:2|2\.5|3|3\.5)\b`, 'g')
    const small = sources.flatMap((s) =>
      [...s.text.matchAll(smallProp), ...s.text.matchAll(smallClass)].map(() => s.file),
    )
    expect(small).toEqual([])
  })
})

const SMALL_ICON_EXCEPTIONS = ['.git-surface .ref svg']
const SMALL_SIZE = /(?:width|height):\s*(?:[0-9]|1[0-5])px/

function iconClasses(): Set<string> {
  const found = new Set<string>()
  for (const { text } of sources) {
    for (const tag of text.matchAll(/<\w+Icon\b[^>]*>/g)) {
      const attribute = /className=(?:"([^"]*)"|\{([^}]*)\})/.exec(tag[0])
      const literal =
        attribute?.[1] ??
        [...(attribute?.[2] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1]).join(' ')
      for (const name of literal.split(/\s+/)) if (/^[a-z][\w-]*$/.test(name)) found.add(name)
    }
  }
  return found
}

function lastCompound(selector: string): string {
  return (
    selector
      .trim()
      .split(/[\s>+~]+/)
      .pop() ?? ''
  )
}

describe('icon size', () => {
  it('is never set under 16 px in a stylesheet, except the chips of git refs', () => {
    const classes = iconClasses()
    const offenders = readdirSync(renderer, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.css'))
      .flatMap((f) => {
        const css = readFileSync(join(renderer, f), 'utf8')
        return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
          .filter((m) => SMALL_SIZE.test(m[2] ?? ''))
          .flatMap((m) => (m[1] ?? '').split(','))
          .map((selector) => selector.trim().replace(/\s+/g, ' '))
          .filter((selector) => {
            if (/\bsvg\b/.test(selector)) return true
            const target = lastCompound(selector)
            return [...classes].some((name) => new RegExp(`\\.${name}(?![\\w-])`).test(target))
          })
          .filter((selector) => !SMALL_ICON_EXCEPTIONS.includes(selector))
          .map((selector) => `${f}: ${selector}`)
      })
    expect(offenders).toEqual([])
  })
})
