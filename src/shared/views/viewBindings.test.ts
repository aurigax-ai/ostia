import { describe, expect, it } from 'vitest'
import { lookup, resolveArgs, resolveText, resolveValue } from './viewBindings'

const fmt = { now: Date.UTC(2026, 0, 1, 12, 0, 0), locale: 'en' }

const scope = {
  workspace: { name: 'ostia', unread: 3, tags: ['a', 'b'], empty: [] as string[] },
  workspaces: [{ name: 'one' }, { name: 'two' }],
  clock: { now: fmt.now },
}

describe('lookup', () => {
  it('follows own properties and array indices', () => {
    expect(lookup(scope, ['workspace', 'name'])).toBe('ostia')
    expect(lookup(scope, ['workspaces', '1', 'name'])).toBe('two')
  })

  it('returns undefined for missing paths', () => {
    expect(lookup(scope, ['workspace', 'missing', 'deeper'])).toBeUndefined()
    expect(lookup(scope, ['nothing'])).toBeUndefined()
    expect(lookup(scope, ['workspaces', '9', 'name'])).toBeUndefined()
  })

  it('never reaches prototypes or built-in members', () => {
    expect(lookup(scope, ['workspace', '__proto__'])).toBeUndefined()
    expect(lookup(scope, ['workspace', 'constructor'])).toBeUndefined()
    expect(lookup(scope, ['workspace', 'toString'])).toBeUndefined()
    expect(lookup(scope, ['workspace', 'name', 'length'])).toBeUndefined()
    expect(lookup(scope, ['workspaces', 'length'])).toBeUndefined()
    expect(lookup(scope, ['workspaces', 'map'])).toBeUndefined()
    expect(lookup({ d: new Date(0) }, ['d', 'getTime'])).toBeUndefined()
  })
})

describe('resolveText', () => {
  it('fills bindings inside text and blanks missing ones', () => {
    expect(resolveText('Hi {{workspace.name}}!', scope, fmt)).toBe('Hi ostia!')
    expect(resolveText('[{{workspace.nope}}]', scope, fmt)).toBe('[]')
    expect(resolveText('{{workspace}}', scope, fmt)).toBe('')
  })

  it('applies filters left to right', () => {
    expect(resolveText('{{workspace.name | upper}}', scope, fmt)).toBe('OSTIA')
    expect(resolveText('{{workspaces | count}}', scope, fmt)).toBe('2')
    expect(resolveText('{{workspace.empty | count}}', scope, fmt)).toBe('0')
    expect(resolveText('{{workspace.nope | count}}', scope, fmt)).toBe('0')
    expect(resolveValue('{{workspace.empty | not}}', scope, fmt)).toBe(true)
    expect(resolveValue('{{workspace.tags | not}}', scope, fmt)).toBe(false)
  })

  it('formats times relative to now', () => {
    expect(resolveText('{{clock.now | relative}}', scope, fmt)).toBe('now')
    const earlier = { t: fmt.now - 5 * 60_000 }
    expect(resolveText('{{t | relative}}', earlier, fmt)).toBe('5 minutes ago')
    expect(resolveText('{{t | time}}', { t: 'x' }, fmt)).toBe('')
  })

  it('counts a relative time in days, hours, minutes or seconds', () => {
    const relative = (offset: number, locale = 'en'): string =>
      resolveText('{{t | relative}}', { t: fmt.now + offset }, { ...fmt, locale })
    expect(relative(-400)).toBe('now')
    expect(relative(-600)).toBe('1 second ago')
    expect(relative(600)).toBe('in 1 second')
    expect(relative(-45_000)).toBe('45 seconds ago')
    expect(relative(-59_600)).toBe('60 seconds ago')
    expect(relative(-60_000)).toBe('1 minute ago')
    expect(relative(-89 * 60_000)).toBe('1 hour ago')
    expect(relative(-23 * 3_600_000)).toBe('23 hours ago')
    expect(relative(-24 * 3_600_000)).toBe('yesterday')
    expect(relative(-365 * 86_400_000)).toBe('365 days ago')
    expect(relative(2 * 3_600_000)).toBe('in 2 hours')
    expect(relative(-45_000, 'zh-Hant')).toBe('45 秒前')
    expect(resolveText('{{t | relative}}', { t: Number.NaN }, fmt)).toBe('')
  })
})

describe('resolveArgs', () => {
  it('keeps the type of a whole-string binding and fills nested strings', () => {
    expect(
      resolveArgs(
        { index: '{{workspace.unread}}', name: 'ws {{workspace.name}}', n: 1 },
        scope,
        fmt,
      ),
    ).toEqual({ index: 3, name: 'ws ostia', n: 1 })
  })
})
