import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { sourceFiles } from '../../../../test/sourceFiles'
import { reducedMotionNow, useMotionAttribute, useReducedMotion } from './motion'

const css = readFileSync(resolve(process.cwd(), 'src/renderer/index.css'), 'utf8')

const styleFiles = [
  ...sourceFiles('src/renderer', '**/*.css'),
  ...sourceFiles('src/extensions', '**/*.css'),
  ...sourceFiles(join('packages', 'extension-sdk', 'src', 'client'), '**/*.css'),
]
const codeFiles = [
  ...sourceFiles('src/renderer', '**/*.{ts,tsx}'),
  ...sourceFiles('src/extensions', '**/*.{ts,tsx}'),
]

const RAW_TIMING =
  /(?<![\w.-])(?!0m?s\b|0\.001ms\b)\d*\.?\d+m?s\b|cubic-bezier|steps\(|\bease(?:-in|-out|-in-out)?\b|\blinear\b/

const LAYOUT_PROPERTY =
  /^(?:all|width|height|(?:min|max)-(?:width|height)|inset|top|right|bottom|left|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|flex(?:-[a-z]+)?|grid(?:-[a-z]+)?|gap|(?:row|column)-gap|font-size|line-height)$/

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
  /\bsmoothScrolling:(?!\s*false\b)/,
  /\bsmoothScrollDuration\s*[:=]\s*[1-9]/,
]

function motionDeclarations(source: string): string[] {
  const found: string[] = []
  const decl = /(?:^|[;{\s])((?:transition|animation)(?:-[a-z-]+)?\s*:[^;{}]+)/g
  for (const match of source.matchAll(decl)) found.push(match[1].replace(/\s+/g, ' ').trim())
  return found
}

function keyframeBlocks(source: string): Array<{ name: string; body: string }> {
  const blocks: Array<{ name: string; body: string }> = []
  for (const match of source.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    let depth = 1
    let i = match.index + match[0].length
    const start = i
    while (depth > 0 && i < source.length) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') depth--
      i++
    }
    blocks.push({ name: match[1], body: source.slice(start, i - 1) })
  }
  return blocks
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
  cleanup()
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

describe('reducedMotionNow', () => {
  function osPrefersReduced(matches: boolean): void {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) => ({ matches, media: query }) as unknown as MediaQueryList,
    )
  }

  afterEach(() => vi.restoreAllMocks())

  it('follows the OS preference in system mode and lets the setting override it', () => {
    osPrefersReduced(true)
    expect(reducedMotionNow()).toBe(true)
    act(() => useSettingsStore.getState().setMotion('full'))
    expect(reducedMotionNow()).toBe(false)
    osPrefersReduced(false)
    expect(reducedMotionNow()).toBe(false)
    act(() => useSettingsStore.getState().setMotion('reduced'))
    expect(reducedMotionNow()).toBe(true)
  })
})

describe('motion CSS contract', () => {
  it('pulses the waiting dot exactly three times, never forever', () => {
    const waiting = ruleBody('.dot.waiting::after')
    expect(waiting).toMatch(/animation: waiting-ring var\(--motion-pulse\) var\(--ease-out\) 3;/)
    expect(ruleBody('.dot.waiting')).not.toMatch(/animation/)
  })

  it('blinks the tab icon of a pane that needs you exactly three times', () => {
    expect(ruleBody('.pane-tab .pane-kind-blink')).toMatch(
      /animation: attn-blink var\(--motion-pulse\) var\(--ease-out\) 3;/,
    )
  })

  it('lets only the working breathe loop forever', () => {
    const infinite = css.split('\n').filter((l) => /\binfinite\b/.test(l))
    expect(infinite).toEqual([
      '  animation: breathe var(--motion-breathe) var(--ease-in-out) infinite;',
    ])
    expect(ruleBody('.state-dot.working')).toContain('infinite')
  })

  it('keeps every other infinite animation out of panel and typeset styles', () => {
    for (const file of styleFiles.filter((f) => !f.endsWith('src/renderer/index.css'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\binfinite\b/)
    }
  })

  it('exits a notice by opacity and a small movement on the exit tokens, edge bars by translate', () => {
    expect(ruleBody('.notice-slot[data-leaving] .motion-enter')).toContain(
      'animation: overlay-out var(--motion-base-exit) var(--ease-in) forwards;',
    )
    expect(ruleBody('.notice-slot[data-leaving] .motion-enter-edge')).toContain(
      'animation: edge-out var(--motion-base-exit) var(--ease-in) forwards;',
    )
  })

  it('reveals a collapsible by opacity and a small translate, with no close transition', () => {
    expect(ruleBody('.motion-reveal-panel')).toContain('transition-property: opacity, transform;')
    expect(ruleBody('.motion-reveal-panel[data-starting-style]')).toMatch(
      /opacity: 0;\n {2}transform: translateY\(-2px\);/,
    )
    expect(css).not.toContain('.motion-reveal-panel[data-ending-style]')
  })

  it('gives panels every motion token of the app, scaled by the reduced-motion setting', () => {
    const panel = readFileSync(
      resolve(process.cwd(), join('packages', 'extension-sdk', 'src', 'client'), 'panel.css'),
      'utf8',
    )
    const durations = ['panel', 'pulse', 'breathe', 'highlight'].map((name) => `--motion-${name}`)
    for (const token of [...durations, '--ease-in-out']) {
      expect(css, token).toMatch(new RegExp(`^\\s+${token}:`, 'm'))
      expect(panel, token).toMatch(new RegExp(`^\\s+${token}:`, 'm'))
    }
    for (const token of durations) {
      expect(panel, token).toContain(`${token}: calc(`)
      expect(panel, token).toContain('* var(--ostia-motion-scale, 1))')
    }
  })

  it('animates only opacity and transform in every keyframe of every style file', () => {
    const keyframes = styleFiles.flatMap((file) =>
      keyframeBlocks(readFileSync(file, 'utf8')).map((block) => ({ file, ...block })),
    )
    expect(keyframes.length).toBeGreaterThan(0)
    const offenders = keyframes.flatMap(({ file, name, body }) =>
      [...body.matchAll(/([a-z-]+)\s*:/g)]
        .map((m) => m[1])
        .filter((prop) => prop !== 'transform' && prop !== 'opacity')
        .map((prop) => `${file}: ${name} animates ${prop}`),
    )
    expect(offenders).toEqual([])
  })

  it('times every transition and animation with the motion tokens', () => {
    const offenders = styleFiles.flatMap((file) =>
      motionDeclarations(readFileSync(file, 'utf8'))
        .filter((decl) => RAW_TIMING.test(stripVars(decl)))
        .map((decl) => `${file}: ${decl}`),
    )
    expect(offenders).toEqual([])
  })

  it('never transitions a layout property, so a panel toggle reflows once', () => {
    const transitioned = (decl: string): string[] => {
      const [prop, value] = decl.split(/:(.*)/s)
      const parts = value.split(',').map((part) => part.trim())
      return prop.trim() === 'transition-property' ? parts : parts.map((p) => p.split(/\s+/)[0])
    }
    const cssOffenders = styleFiles.flatMap((file) =>
      motionDeclarations(readFileSync(file, 'utf8'))
        .filter((decl) => /^transition(-property)?\s*:/.test(decl))
        .filter((decl) => transitioned(decl).some((name) => LAYOUT_PROPERTY.test(name)))
        .map((decl) => `${file}: ${decl}`),
    )
    const codeOffenders = codeFiles.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/\btransition-\[([^\]]+)\]/g)]
        .filter((m) => m[1].split(',').some((name) => LAYOUT_PROPERTY.test(name.trim())))
        .map((m) => `${file}: ${m[0]}`),
    )
    expect([...cssOffenders, ...codeOffenders]).toEqual([])
  })

  const railRules = [
    ...css.matchAll(/\n((?:\.deck-rail|:root\[data-rail-motion)[^{\n]*)\{([^}]*)\}/g),
  ]

  it('slides the sidebar with transform and opacity only, so a toggle reflows once', () => {
    const animated = railRules.flatMap(([, , body]) =>
      [...body.matchAll(/animation:\s*([a-z-]+)/g)].map((m) => m[1]),
    )
    expect(new Set(animated)).toEqual(new Set(['rail-slide', 'rail-content-fade', 'rail-follow']))
    for (const name of animated) {
      const start = css.indexOf(`@keyframes ${name} {`)
      expect(start, name).toBeGreaterThan(-1)
      const body = css.slice(start, css.indexOf('\n}', start))
      const props = [...body.matchAll(/^\s+([a-z-]+):/gm)].map((m) => m[1])
      expect(props.length, name).toBeGreaterThan(0)
      expect(
        props.filter((p) => p !== 'transform' && p !== 'opacity'),
        name,
      ).toEqual([])
    }
    const durations = railRules.flatMap(([, , body]) =>
      [...body.matchAll(/animation:\s*[a-z-]+\s+var\((--motion-[a-z-]+)\)/g)].map((m) => m[1]),
    )
    expect(new Set(durations)).toEqual(new Set(['--motion-panel']))
    expect(css).toMatch(/--motion-panel: (1[5-9]\d|200)ms;/)
  })

  it('moves the main area and middle panels with the sidebar edge, on one shared timing', () => {
    const follow = railRules.filter(([, selector]) => /\.workzone/.test(selector))
    expect(follow.map(([, selector]) => selector.trim())).toEqual([
      ':root[data-rail-motion] .app > :is(.files-panel, .workzone)',
      ':root[data-rail-motion="opening"] .app > :is(.files-panel, .workzone)',
      ':root[data-rail-motion="closing"] .app > :is(.files-panel, .workzone)',
    ])
    const timings = railRules.flatMap(([, , body]) =>
      [...body.matchAll(/animation:\s*[a-z-]+\s+(var\([^)]+\)\s+var\([^)]+\))/g)].map((m) => m[1]),
    )
    expect(new Set(timings)).toEqual(new Set(['var(--motion-panel) var(--ease-in-out)']))
    expect(css).toContain('transform: translateX(calc(var(--rail-w-collapsed) - var(--rail-w)));')
    expect(css).toContain('transform: translateX(calc(var(--rail-w) - var(--rail-w-collapsed)));')
    const footprint = railRules.find(([, selector]) =>
      /\[data-rail-motion\] \.app\s*$/.test(selector),
    )
    expect(footprint?.[2]).toMatch(
      /grid-template-columns: var\(--rail-w-collapsed\) auto 1fr auto;/,
    )
    expect(footprint?.[2]).toMatch(/overflow: clip;/)
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
