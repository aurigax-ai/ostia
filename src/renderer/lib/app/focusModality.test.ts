import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sourceFiles } from '../../../../test/sourceFiles'
import { isNavigationKey, startFocusModality } from './focusModality'

const root = document.documentElement

function key(key: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
}

function pointerDown(): void {
  window.dispatchEvent(new Event('pointerdown', { bubbles: true }))
}

describe('focus modality', () => {
  let stop: (() => void) | undefined
  afterEach(() => {
    stop?.()
    stop = undefined
  })

  it('starts in keyboard navigation so no focus ring is lost before the first click', () => {
    stop = startFocusModality()
    expect(root.dataset.keyboardNav).toBe('')
  })

  it('a pointer press leaves keyboard navigation, and modifiers, chords and typing keep it off', () => {
    stop = startFocusModality()
    pointerDown()
    expect('keyboardNav' in root.dataset).toBe(false)
    key('Control', { ctrlKey: true })
    key('Shift', { shiftKey: true })
    key('P', { ctrlKey: true, shiftKey: true })
    key('Tab', { ctrlKey: true })
    key('ArrowLeft', { altKey: true })
    key('ArrowDown', { metaKey: true })
    key('a')
    key('Enter')
    key('Escape')
    expect('keyboardNav' in root.dataset).toBe(false)
  })

  it('Tab, Shift+Tab, arrows, Home, End and paging enter keyboard navigation', () => {
    stop = startFocusModality()
    for (const name of ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      pointerDown()
      key(name)
      expect(root.dataset.keyboardNav, name).toBe('')
    }
    pointerDown()
    key('Tab', { shiftKey: true })
    expect(root.dataset.keyboardNav).toBe('')
    expect(
      isNavigationKey({ key: 'PageDown', ctrlKey: false, metaKey: false, altKey: false }),
    ).toBe(true)
  })

  it('stops listening and clears the attribute', () => {
    startFocusModality()()
    expect('keyboardNav' in root.dataset).toBe(false)
    key('Tab')
    expect('keyboardNav' in root.dataset).toBe(false)
  })
})

function named(file: string): string {
  return relative(process.cwd(), file)
}

const RING_CLASS =
  /[^\s"'`]*focus-(?:visible|within)[^\s"'`]*:-?(?:ring|outline|border|shadow)[^\s"'`]*/g

const RING_DECLARATION =
  /(?:^|[;{\s])((?:outline(?:-(?:color|style|width))?|box-shadow|border(?:-[a-z-]+)?)\s*:\s*[^;{}]+)/g

const GLOBAL_RULE = ':read-write:focus-visible'

function focusRules(source: string): { selector: string; body: string }[] {
  const rules: { selector: string; body: string }[] = []
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].replace(/\s+/g, ' ').trim()
    const own = selector
      .split(',')
      .some((part) => /:focus(?:-visible|-within)?\)*$/.test(part.trim()))
    if (own) rules.push({ selector, body: match[2] })
  }
  return rules
}

describe('one focus indicator', () => {
  it('no component brings its own focus ring classes', () => {
    const found: string[] = []
    for (const file of sourceFiles('src/renderer', '**/*.{ts,tsx}')) {
      for (const match of readFileSync(file, 'utf8').matchAll(RING_CLASS)) {
        found.push(`${named(file)}: ${match[0]}`)
      }
    }
    expect(found).toEqual([])
  })

  it('only the global rule in index.css draws a focus outline, and it never sets a radius', () => {
    const found: string[] = []
    const globals: string[] = []
    for (const file of sourceFiles('src/renderer', '**/*.css')) {
      for (const { selector, body } of focusRules(readFileSync(file, 'utf8'))) {
        if (selector.includes(GLOBAL_RULE)) {
          globals.push(named(file))
          expect(body.replace(/\s+/g, ' ').trim()).toBe(
            'outline: 2px solid var(--brand); outline-offset: 1px;',
          )
          continue
        }
        for (const match of body.matchAll(RING_DECLARATION)) {
          const declaration = match[1].replace(/\s+/g, ' ').trim()
          if (/^outline\s*:\s*none$/.test(declaration)) continue
          found.push(`${named(file)}: ${selector} { ${declaration} }`)
        }
      }
    }
    expect(found).toEqual([])
    expect(globals).toEqual(['src/renderer/index.css'])
  })

  it('the global rule shows the ring for keyboard navigation and for text fields only', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/index.css'), 'utf8')
    const rule = focusRules(css).find((r) => r.selector.includes(GLOBAL_RULE))
    const parts = rule?.selector.split(',').map((part) => part.replace(/\s+/g, ' ').trim())
    expect(parts).toEqual([
      ':root[data-keyboard-nav] :focus-visible',
      ':root[data-keyboard-nav] [data-focus-ring="within"]:has(:focus-visible)',
      ':read-write:focus-visible',
      '[data-slot="input-group"]:has(.input-group-control:focus-visible):not( [data-slot="combobox-content"] * )',
    ])
  })

  it('the manager composer is the one place that hides the ring', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/index.css'), 'utf8')
    const hiders = [...css.matchAll(/([^{}]+)\{\s*outline:\s*none;\s*\}/g)]
      .map((match) => match[1].replace(/\s+/g, ' ').trim())
      .filter((selector) => /\S :focus-visible$/.test(selector))
    expect(hiders).toEqual([
      '.manager-agent .chat-view form [data-slot="input-group"], .manager-agent .chat-view form :focus-visible',
    ])
  })
})
