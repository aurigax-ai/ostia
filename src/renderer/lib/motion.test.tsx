import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { useMotionAttribute, useReducedMotion } from './motion'

const css = readFileSync(resolve(process.cwd(), 'src/renderer/index.css'), 'utf8')

function sourceFiles(dir: string, extensions: string[]): string[] {
  const root = resolve(process.cwd(), dir)
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => extensions.some((ext) => f.endsWith(ext)) && !/\.test\.tsx?$/.test(f))
    .map((f) => join(root, f))
}

const styleFiles = [
  ...sourceFiles('src/renderer', ['.css']),
  ...sourceFiles('src/extensions', ['.css']),
]
const codeFiles = [
  ...sourceFiles('src/renderer', ['.ts', '.tsx']),
  ...sourceFiles('src/extensions', ['.ts', '.tsx']),
]

const RAW_TIMING =
  /(?<![\w.-])(?!0m?s\b|0\.001ms\b)\d*\.?\d+m?s\b|cubic-bezier|steps\(|\bease(?:-in|-out|-in-out)?\b|\blinear\b/

const FORBIDDEN_CODE_MOTION = [
  /\b(?:duration|delay)-(?:\d|\[)/,
  /\bease-(?:linear|in|out|in-out|\[)/,
  /\banimate-(?!none\b)[a-z[]/,
  /\b(?:zoom|fade|spin)-(?:in|out)\b/,
  /\bslide-(?:in|out)-/,
  /\btransition-all\b/,
  /\b(?:active|data-pressed|data-\[pressed\]):-?(?:scale|translate)/,
  /\b(?:transition|animation)(?:Duration|TimingFunction|Delay)?\s*:\s*['"`]/,
  /\bbehavior:\s*['"]smooth['"]/,
]

function motionDeclarations(source: string): string[] {
  const found: string[] = []
  const decl = /(?:^|[;{\s])((?:transition|animation)(?:-[a-z-]+)?\s*:[^;{}]+)/g
  for (const match of source.matchAll(decl)) found.push(match[1].replace(/\s+/g, ' ').trim())
  return found
}

function stripVars(declaration: string): string {
  let out = declaration.replace(/^[a-z-]+\s*:/, '')
  while (/var\([^()]*\)/.test(out)) out = out.replace(/var\([^()]*\)/g, '')
  return out
}

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

describe('useReducedMotion', () => {
  function osPrefersReduced(matches: boolean): void {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    )
  }

  afterEach(() => vi.restoreAllMocks())

  it('follows the OS preference while motion is set to system', () => {
    osPrefersReduced(true)
    expect(renderHook(() => useReducedMotion()).result.current).toBe(true)
    osPrefersReduced(false)
    expect(renderHook(() => useReducedMotion()).result.current).toBe(false)
  })

  it('lets the reduced and full settings override the OS', () => {
    osPrefersReduced(true)
    act(() => useSettingsStore.getState().setMotion('full'))
    expect(renderHook(() => useReducedMotion()).result.current).toBe(false)
    osPrefersReduced(false)
    act(() => useSettingsStore.getState().setMotion('reduced'))
    expect(renderHook(() => useReducedMotion()).result.current).toBe(true)
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

  it('keeps every other infinite animation out of panel and typeset styles', () => {
    for (const file of styleFiles.filter((f) => !f.endsWith('src/renderer/index.css'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\binfinite\b/)
    }
  })

  it('times every transition and animation with the motion tokens', () => {
    const offenders = styleFiles.flatMap((file) =>
      motionDeclarations(readFileSync(file, 'utf8'))
        .filter((decl) => RAW_TIMING.test(stripVars(decl)))
        .map((decl) => `${file}: ${decl}`),
    )
    expect(offenders).toEqual([])
  })

  it('uses no raw durations, easings, press scaling or tw-animate classes in code', () => {
    const offenders = codeFiles.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          FORBIDDEN_CODE_MOTION.filter((re) => re.test(line)).map((re) => `${file}:${i + 1} ${re}`),
        ),
    )
    expect(offenders).toEqual([])
  })

  it('collapses motion for reduced, and for system only when the OS asks', () => {
    expect(css).toContain(':root[data-motion="reduced"] *,')
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\n {2}:root:not\(\[data-motion="full"\]\) \*,/,
    )
  })
})
