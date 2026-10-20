import { describe, expect, it } from 'vitest'
import { candidateGroups } from './grouping'
import type { Signal } from './signal'

const DAY = 24 * 60 * 60 * 1000
const NOW = 100 * DAY

let seq = 0
function signal(text: string, extra: Partial<Signal> = {}): Signal {
  seq += 1
  return {
    id: `s${seq}`,
    at: NOW,
    kind: 'prompt',
    agent: 'claude',
    text,
    session: `sess-${seq}`,
    pane: 'p',
    workspace: 'w',
    project: 'project:github.com/acme/shop',
    stacks: ['node'],
    ...extra,
  }
}

describe('candidateGroups', () => {
  it('groups corrections that say the same thing across sessions and days', () => {
    const signals = [
      signal('No comments in the code, I told you last time.', { at: NOW - 3 * DAY }),
      signal('No comments please, the code should explain itself.', { at: NOW - 2 * DAY }),
      signal('Remove the comments again, never add comments.', { at: NOW - DAY }),
      signal('Use pnpm here, never npm.', { at: NOW }),
    ]
    const groups = candidateGroups(signals)
    expect(groups).toHaveLength(1)
    expect(groups[0].signals.map((s) => s.id)).toEqual([
      signals[0].id,
      signals[1].id,
      signals[2].id,
    ])
    expect(groups[0].words).toContain('comment')
    expect(groups[0].scope).toBe('project:github.com/acme/shop')
  })

  it('needs three prompts, two sessions and two days', () => {
    const text = 'Never add comments to the code.'
    const two = [signal(text, { at: NOW - DAY }), signal(text, { at: NOW })]
    expect(candidateGroups(two)).toEqual([])
    const oneSession = [
      signal(text, { at: NOW - 2 * DAY, session: 'one' }),
      signal(text, { at: NOW - DAY, session: 'one' }),
      signal(text, { at: NOW, session: 'one' }),
    ]
    expect(candidateGroups(oneSession)).toEqual([])
    const oneDay = [signal(text), signal(text), signal(text)]
    expect(candidateGroups(oneDay)).toEqual([])
    const enough = [
      signal(text, { at: NOW - DAY }),
      signal(text, { at: NOW }),
      signal(text, { at: NOW }),
    ]
    expect(candidateGroups(enough)).toHaveLength(1)
  })

  it('ignores prompts that are not corrections or preferences', () => {
    const plain = [
      signal('Add a retry helper to the http client.', { at: NOW - 2 * DAY }),
      signal('Add a retry helper to the http client please.', { at: NOW - DAY }),
      signal('Add a retry helper to the http client now.', { at: NOW }),
    ]
    expect(candidateGroups(plain)).toEqual([])
  })

  it('counts a reworded re-ask in one session as a correction', () => {
    const pair = (at: number, session: string) => [
      signal('Put the helper in its own file', { at, session }),
      signal('put the helper in its own file now', { at: at + 60_000, session }),
    ]
    const reask = [...pair(NOW - 2 * DAY, 'a'), ...pair(NOW - DAY, 'b'), ...pair(NOW, 'c')]
    expect(candidateGroups(reask)).toHaveLength(1)
    const apart = [
      signal('Put the helper in its own file', { at: NOW - 2 * DAY, session: 'a' }),
      signal('Put the helper in its own file', { at: NOW - DAY, session: 'b' }),
      signal('Put the helper in its own file', { at: NOW, session: 'c' }),
    ]
    expect(candidateGroups(apart)).toEqual([])
  })

  it('keeps unrelated corrections in separate groups', () => {
    const a = (at: number, session: string) =>
      signal('Never add comments to the code.', { at, session })
    const b = (at: number, session: string) =>
      signal('Always use pnpm, not npm, for installs.', { at, session })
    const groups = candidateGroups([
      a(NOW - 2 * DAY, 'a1'),
      a(NOW - DAY, 'a2'),
      a(NOW, 'a3'),
      b(NOW - 2 * DAY, 'b1'),
      b(NOW - DAY, 'b2'),
      b(NOW, 'b3'),
    ])
    expect(groups).toHaveLength(2)
  })

  it('picks the project when every prompt came from one, a stack when they share one, else global', () => {
    const text = 'Never add comments to the code.'
    const build = (extra: (i: number) => Partial<Signal>) =>
      [0, 1, 2].map((i) => signal(text, { at: NOW - i * DAY, ...extra(i) }))
    expect(candidateGroups(build(() => ({})))[0].scope).toBe('project:github.com/acme/shop')
    expect(
      candidateGroups(build((i) => ({ project: `project:github.com/acme/p${i}` })))[0].scope,
    ).toBe('stack:node')
    expect(
      candidateGroups(build((i) => ({ project: null, stacks: i === 0 ? ['go'] : ['node'] })))[0]
        .scope,
    ).toBe('global')
  })

  it('groups prompts written in Chinese', () => {
    const text = '請不要加註解，程式碼要自己說明。'
    const groups = candidateGroups([
      signal(text, { at: NOW - 2 * DAY }),
      signal('不要再加註解了', { at: NOW - DAY }),
      signal('註解不要寫，我說過了', { at: NOW }),
    ])
    expect(groups).toHaveLength(1)
  })

  it('returns nothing for no signals', () => {
    expect(candidateGroups([])).toEqual([])
  })
})
