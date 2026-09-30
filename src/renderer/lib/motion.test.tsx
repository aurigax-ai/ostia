import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { useMotionAttribute } from './motion'

const css = readFileSync(resolve(process.cwd(), 'src/renderer/index.css'), 'utf8')

function ruleBody(selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  if (start < 0) throw new Error(`no rule for ${selector}`)
  return css.slice(start, css.indexOf('\n}', start))
}

let settingsInit: ReturnType<typeof useSettingsStore.getState>

beforeAll(() => {
  settingsInit = useSettingsStore.getState()
})

afterEach(() => {
  useSettingsStore.setState(settingsInit, true)
  delete document.documentElement.dataset.motion
})

describe('useMotionAttribute', () => {
  it('mirrors appearance.motion onto <html data-motion>', () => {
    renderHook(() => useMotionAttribute())
    expect(document.documentElement.dataset.motion).toBe('system')

    act(() => useSettingsStore.getState().setMotion('reduced'))
    expect(document.documentElement.dataset.motion).toBe('reduced')

    act(() => useSettingsStore.getState().setByPath('appearance.motion', 'full'))
    expect(document.documentElement.dataset.motion).toBe('full')
  })

  it('refuses an unknown value an agent writes and keeps the current mode', () => {
    renderHook(() => useMotionAttribute())
    expect(() =>
      act(() => {
        useSettingsStore.getState().setByPath('appearance.motion', 'wobbly')
      }),
    ).toThrow('invalid value for appearance.motion')
    expect(document.documentElement.dataset.motion).toBe('system')
  })
})

describe('motion CSS contract', () => {
  it('pulses the waiting dot exactly three times, never forever', () => {
    const waiting = ruleBody('.dot.waiting::after')
    expect(waiting).toMatch(/animation: waiting-ring var\(--motion-pulse\) var\(--ease-out\) 3;/)
    expect(ruleBody('.dot.waiting')).not.toMatch(/animation/)
  })

  it('pulses the pane attention ring twice after it fades in', () => {
    expect(ruleBody('.pane-attn-pulse')).toMatch(
      /animation: attn-pulse var\(--motion-pulse\) var\(--ease-out\) var\(--motion-base\) 2;/,
    )
  })

  it('lets only the working breathe loop forever', () => {
    const infinite = css.split('\n').filter((l) => /\binfinite\b/.test(l))
    expect(infinite).toEqual([
      '  animation: breathe var(--motion-breathe) var(--ease-in-out) infinite;',
    ])
    expect(ruleBody('.dot.working')).toContain('infinite')
  })

  it('collapses motion for reduced, and for system only when the OS asks', () => {
    expect(css).toContain(':root[data-motion="reduced"] *,')
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\n {2}:root:not\(\[data-motion="full"\]\) \*,/,
    )
  })
})
