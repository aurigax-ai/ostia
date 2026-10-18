import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeHookSettings, writeClaudePlugin } from './claudeIntegration'
import {
  MOD_BUSY_RETRY_MS,
  MOD_DRAFT_QUIET_MS,
  MOD_SAFETY_MS,
  MOD_TICK_MS,
  MOD_WAITING_STATUS,
  type ModOn,
  register,
} from './claudeMod/register'

const source = readFileSync(join(import.meta.dirname, 'claudeMod', 'register.ts'), 'utf8')

type Hook = (...args: never[]) => unknown

describe('the mod’s surface', () => {
  it('registers only prompt.edit, session.start and session.end', () => {
    const events = [...source.matchAll(/\bon\('([a-z.]+)'/g)].map((m) => m[1])
    expect(events).toEqual(['prompt.edit', 'session.start', 'session.end'])
  })

  it('calls only the $ methods it needs and none that write a file, send a message or reach the net', () => {
    const calls = new Set([...source.matchAll(/\$\.(\w+\.\w+)\(/g)].map((m) => m[1]))
    expect([...calls].sort()).toEqual([
      'clock.every',
      'env.get',
      'fs.read',
      'process.run',
      'prompt.read',
      'prompt.submit',
      'session.id',
      'ui.status',
    ])
  })

  it('reads three environment names, runs only bus hook verbs and never submits as the human', () => {
    expect([...source.matchAll(/\$\.env\.get\('(\w+)'\)/g)].map((m) => m[1])).toEqual([
      'OSTIA_MAIL_FILE',
      'OSTIA_NODE',
      'OSTIA_CLI',
    ])
    expect([...source.matchAll(/hook\(\$, \['([a-z-]+)'/g)].map((m) => m[1]).sort()).toEqual([
      'ack',
      'mod-ready',
      'take',
    ])
    expect(source).not.toContain('asUser')
    expect(source).not.toMatch(/import\s|require\(/)
  })
})

describe('the plugin Ostia writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'ostia-claude-plugin-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('carries the mod beside the command hooks, and the same file as the source', () => {
    const dir = join(root, 'plugin')
    mkdirSync(dir)
    writeClaudePlugin(dir)
    const hooks = JSON.parse(readFileSync(join(dir, 'hooks', 'hooks.json'), 'utf8'))
    expect(hooks.modules).toEqual(['./register.ts'])
    expect(hooks.hooks.Stop).toBeDefined()
    expect(readFileSync(join(dir, 'hooks', 'register.ts'), 'utf8')).toBe(source)
  })

  it('leaves the command hooks settings free of the mod', () => {
    expect(claudeHookSettings()).not.toHaveProperty('modules')
  })
})

interface Calls {
  run: string[][]
  status: (string | undefined)[]
  submitted: string[]
}

function setup(
  options: {
    env?: Record<string, string>
    draft?: () => string
    flag?: () => string | undefined
    taken?: () => unknown
    submit?: () => Promise<unknown>
  } = {},
) {
  const hooks = new Map<string, Hook>()
  const on: ModOn = (event, hook) => void hooks.set(event, hook as Hook)
  register(on)
  const calls: Calls = { run: [], status: [], submitted: [] }
  let tickFn: () => void = () => {}
  const timer = { cancel: vi.fn() }
  const env = options.env ?? {
    OSTIA_MAIL_FILE: '/tmp/mail',
    OSTIA_NODE: '/node',
    OSTIA_CLI: '/cli.js',
  }
  const $ = {
    clock: {
      every: (_ms: number, fn: () => void) => {
        tickFn = fn
        return timer
      },
    },
    env: { get: async (name: string) => env[name] },
    fs: {
      read: async () => {
        const flag = options.flag ? options.flag() : '1:1'
        if (flag === undefined) throw new Error('missing')
        return `${flag}\n`
      },
    },
    process: {
      run: async (argv: readonly string[]) => {
        calls.run.push([...argv])
        const verb = argv[4]
        const out = verb === 'take' ? JSON.stringify(options.taken?.() ?? {}) : ''
        return { exitCode: 0, stdout: out }
      },
    },
    prompt: {
      read: async () => ({ text: options.draft?.() ?? '' }),
      submit: async (input: { text: string }) => {
        calls.submitted.push(input.text)
        return options.submit ? options.submit() : {}
      },
    },
    session: { id: async () => 'sess-1' },
    ui: { status: (text: string | undefined) => void calls.status.push(text) },
  }
  const fire = async (event: string, input: unknown = {}) => {
    const hook = hooks.get(event)
    if (!hook) throw new Error(`no hook ${event}`)
    return await (hook as unknown as (...a: unknown[]) => Promise<unknown>)(
      $,
      input,
      async (e: unknown) => e,
    )
  }
  const tick = async () => {
    tickFn()
    await vi.advanceTimersByTimeAsync(0)
  }
  return { calls, fire, tick, timer, hooks }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-18T10:00:00Z'))
})

describe('the mod at work', () => {
  it('stays out of a session nobody sits at, and of a pane Ostia did not set up', async () => {
    const quiet = setup()
    await quiet.fire('session.start', { isInteractive: false })
    expect(quiet.calls.run).toEqual([])
    const bare = setup({ env: {} })
    await bare.fire('session.start', { isInteractive: true })
    expect(bare.calls.run).toEqual([])
  })

  it('says it is ready when the session starts, with the session id, and gone when it ends', async () => {
    const m = setup()
    await m.fire('session.start', { isInteractive: true })
    expect(m.calls.run).toEqual([
      ['/node', '/cli.js', 'bus', 'hook', 'mod-ready', 'sess-1', 'idle'],
    ])
    await m.fire('session.end')
    expect(m.calls.run.at(-1)).toEqual([
      '/node',
      '/cli.js',
      'bus',
      'hook',
      'mod-ready',
      'sess-1',
      'gone',
    ])
    expect(m.timer.cancel).toHaveBeenCalled()
  })

  it('takes mail when the flag changes, submits it as a plugin message and acknowledges the lease', async () => {
    const m = setup({ taken: () => ({ text: 'ostia bus: 1 unread message', lease: 'lease-1' }) })
    await m.fire('session.start', { isInteractive: true })
    await m.tick()
    expect(m.calls.submitted).toEqual(['ostia bus: 1 unread message'])
    expect(m.calls.run.slice(-2).map((argv) => argv.slice(4))).toEqual([
      ['take'],
      ['ack', 'lease-1'],
    ])
  })

  it('does nothing on a tick when the flag did not change, until the safety interval passes', async () => {
    const m = setup()
    await m.fire('session.start', { isInteractive: true })
    await m.tick()
    const taken = m.calls.run.filter((argv) => argv[4] === 'take').length
    await vi.advanceTimersByTimeAsync(MOD_TICK_MS)
    await m.tick()
    expect(m.calls.run.filter((argv) => argv[4] === 'take').length).toBe(taken)
    await vi.advanceTimersByTimeAsync(MOD_SAFETY_MS)
    await m.tick()
    expect(m.calls.run.filter((argv) => argv[4] === 'take').length).toBe(taken + 1)
  })

  it('does not take while the human has a draft or typed a moment ago, and says why', async () => {
    let draft = 'half a sent'
    const m = setup({ draft: () => draft, taken: () => ({ text: 'mail', lease: 'l' }) })
    await m.fire('session.start', { isInteractive: true })
    await m.tick()
    expect(m.calls.run.some((argv) => argv[4] === 'take')).toBe(false)
    expect(m.calls.status.at(-1)).toBe(MOD_WAITING_STATUS)
    expect(m.calls.run.at(-1)?.slice(4)).toEqual(['mod-ready', 'sess-1', 'draft'])

    draft = ''
    await m.fire('prompt.edit', { text: '' })
    await m.tick()
    expect(m.calls.run.some((argv) => argv[4] === 'take')).toBe(false)
    await vi.advanceTimersByTimeAsync(MOD_DRAFT_QUIET_MS)
    await m.tick()
    expect(m.calls.submitted).toEqual(['mail'])
    expect(m.calls.status.at(-1)).toBeUndefined()
    expect(m.calls.run.map((argv) => argv[4])).toContain('take')
    expect(m.calls.run.filter((argv) => argv[4] === 'mod-ready').map((argv) => argv[6])).toEqual([
      'idle',
      'draft',
      'idle',
    ])
  })

  it('tries again later when the agent is busy, and not on every tick', async () => {
    let answer: unknown = { busy: true }
    const m = setup({ taken: () => answer })
    await m.fire('session.start', { isInteractive: true })
    await m.tick()
    const takes = () => m.calls.run.filter((argv) => argv[4] === 'take').length
    expect(takes()).toBe(1)
    await vi.advanceTimersByTimeAsync(MOD_TICK_MS)
    await m.tick()
    expect(takes()).toBe(1)
    answer = { text: 'mail', lease: 'l' }
    await vi.advanceTimersByTimeAsync(MOD_BUSY_RETRY_MS)
    await m.tick()
    expect(m.calls.submitted).toEqual(['mail'])
  })

  it('does not acknowledge a lease when the submit failed, and does not stop', async () => {
    const m = setup({
      taken: () => ({ text: 'mail', lease: 'l' }),
      submit: async () => {
        throw new Error('refused')
      },
    })
    await m.fire('session.start', { isInteractive: true })
    await m.tick()
    expect(m.calls.run.some((argv) => argv[4] === 'ack')).toBe(false)
    await vi.advanceTimersByTimeAsync(MOD_BUSY_RETRY_MS)
    await m.tick()
    expect(m.calls.run.filter((argv) => argv[4] === 'take').length).toBe(2)
  })

  it('shows no waiting status and spawns nothing while no mail is queued, even with a draft', async () => {
    const m = setup({ flag: () => '0:5', draft: () => 'typing' })
    await m.fire('session.start', { isInteractive: true })
    await m.tick()
    await vi.advanceTimersByTimeAsync(MOD_SAFETY_MS)
    await m.tick()
    expect(m.calls.status).toEqual([])
    expect(m.calls.run.map((argv) => argv[4])).toEqual(['mod-ready'])
  })

  it('takes the safety poll only when the flag counts mail, and clears the status when the mail is gone', async () => {
    let flag = '1:1'
    const m = setup({ flag: () => flag, draft: () => 'typing' })
    await m.fire('session.start', { isInteractive: true })
    await m.tick()
    expect(m.calls.status).toEqual([MOD_WAITING_STATUS])
    flag = '0:2'
    await m.tick()
    expect(m.calls.status).toEqual([MOD_WAITING_STATUS, undefined])
  })

  it('submits a lease again returned after a failed acknowledgement only once, and acknowledges it', async () => {
    const m = setup({ taken: () => ({ text: 'mail', lease: 'l', ids: ['a', 'b'] }) })
    await m.fire('session.start', { isInteractive: true })
    await m.tick()
    await vi.advanceTimersByTimeAsync(MOD_SAFETY_MS)
    await m.tick()
    expect(m.calls.submitted).toEqual(['mail'])
    expect(m.calls.run.filter((argv) => argv[4] === 'ack')).toHaveLength(2)
  })

  it('treats a missing flag file as nothing to do', async () => {
    const m = setup({ flag: () => undefined })
    await m.fire('session.start', { isInteractive: true })
    await m.tick()
    expect(m.calls.submitted).toEqual([])
  })
})
