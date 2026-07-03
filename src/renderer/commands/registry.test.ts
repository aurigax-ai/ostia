import { describe, expect, it } from 'vitest'
import { DEFAULT_CAPABILITIES } from '../../shared/capabilities'
import { CommandRegistry } from './registry'

describe('command contract', () => {
  it('a registered command exposes its declared metadata with defaults', () => {
    const reg = new CommandRegistry()
    reg.register({
      id: 'demo.noop',
      title: 'Demo',
      run: () => 42,
    })
    reg.register({
      id: 'demo.risky',
      title: 'Risky',
      capabilities: ['shell'],
      target: 'explicit',
      argsSchema: { type: 'object', properties: { text: { type: 'string' } } },
      run: () => undefined,
    })
    // biome-ignore lint/style/noNonNullAssertion: test fixture — both ids were just registered above.
    const noop = reg.describe().find((c) => c.id === 'demo.noop')!
    // biome-ignore lint/style/noNonNullAssertion: test fixture — both ids were just registered above.
    const risky = reg.describe().find((c) => c.id === 'demo.risky')!
    expect(noop.capabilities).toEqual(DEFAULT_CAPABILITIES)
    expect(noop.target).toBe('active')
    expect(noop.argsSchema).toBeNull()
    expect(noop.resultSchema).toBeNull()
    expect(noop.hidden).toBe(false)
    expect(noop.category).toBeNull()
    expect(risky.capabilities).toEqual(['shell'])
    expect(risky.target).toBe('explicit')
    expect(risky.argsSchema).toEqual({ type: 'object', properties: { text: { type: 'string' } } })
  })
})

describe('exec returns CommandResult', () => {
  it('wraps success, unknown, and thrown into a uniform result', async () => {
    const reg = new CommandRegistry()
    reg.register<{ n: number }, number>({
      id: 'math.double',
      title: 'Double',
      run: ({ n }) => n * 2,
    })
    reg.register({
      id: 'boom',
      title: 'Boom',
      run: () => {
        throw new Error('kaboom')
      },
    })

    const res = await reg.exec('math.double', { n: 21 })
    expect(res).toEqual({ ok: true, result: 42 })
    if (res.ok) expect(res.result).toBe(42)

    const unknown = await reg.exec('nope')
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) {
      expect(unknown.error.code).toBe('unknown-command')
    }

    const thrown = await reg.exec('boom')
    expect(thrown.ok).toBe(false)
    if (!thrown.ok) {
      expect(thrown.error.code).toBe('command-failed')
      expect(thrown.error.message).toContain('kaboom')
    }
  })
})

describe('describe() sorting', () => {
  it('sorts commands by id regardless of registration order', () => {
    const reg = new CommandRegistry()
    reg.register({ id: 'zzz.last', title: 'Last', run: () => undefined })
    reg.register({ id: 'aaa.first', title: 'First', run: () => undefined })

    const ids = reg.describe().map((c) => c.id)
    expect(ids).toEqual(['aaa.first', 'zzz.last'])
  })
})
