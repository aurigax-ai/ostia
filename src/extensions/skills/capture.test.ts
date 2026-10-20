import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionCaller, ExtensionResult } from '@aurigax-ai/ostia-extension-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { signalCapture } from './capture'
import { PROMPT_MAX } from './signal'
import { SIGNALS_FILE, SignalStore } from './signalStore'

const where = { projectKeys: ['github.com/a/b', '/home/me/b'], stacks: ['node'] }

function human(extra: Partial<ExtensionCaller> = {}): ExtensionCaller {
  return {
    kind: 'pane',
    paneId: 'p1',
    workspaceId: 'w1',
    workDir: '/w',
    cwd: '/w/sub',
    humanPrompt: true,
    capabilities: ['agent-plugin'],
    ...extra,
  } as ExtensionCaller
}

function hook(prompt: unknown, session = 'sess-1', event = 'UserPromptSubmit', agent = 'claude') {
  return { argv: [agent, event], stdin: JSON.stringify({ session_id: session, prompt }) }
}

const data = <T>(res: ExtensionResult): T => (res as { data: T }).data

describe('signal capture', () => {
  let dir: string
  let signals: SignalStore
  let kinds: Record<string, string>
  let redactFails: boolean
  let confirmAnswer: boolean
  let scopedDirs: string[]
  let changes: number
  let capture: ReturnType<typeof signalCapture>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-signals-'))
    kinds = { w1: 'terminal', sc: 'scratch' }
    redactFails = false
    confirmAnswer = true
    scopedDirs = []
    changes = 0
    signals = new SignalStore(dir, () => 5000)
    capture = signalCapture({
      signals,
      now: () => 5000,
      redact: async (texts) =>
        redactFails ? null : texts.map((t) => t.replace(/hunter2/g, '[redacted]')),
      workspace: async (id) => (kinds[id] ? { kind: kinds[id], workDir: '/w' } : null),
      folderScopeOf: async (d) => {
        scopedDirs.push(d)
        return where
      },
      confirmForget: async () => confirmAnswer,
      changed: () => {
        changes += 1
      },
    })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const submit = async (args: unknown, caller: ExtensionCaller = human()) => {
    const res = await capture.onPrompt(args, caller)
    await capture.settled()
    return res
  }
  const stored = () => signals.list()

  it('stores a prompt main attributes to the human, with its scope, and answers at once', async () => {
    const res = await capture.onPrompt(hook('never add comments'), human())
    expect(res.ok).toBe(true)
    expect(stored()).toEqual([])
    await capture.settled()
    expect(stored()).toEqual([
      {
        id: 's1',
        at: 5000,
        kind: 'prompt',
        agent: 'claude',
        text: 'never add comments',
        session: 'sess-1',
        pane: 'p1',
        workspace: 'w1',
        project: 'project:github.com/a/b',
        stacks: ['node'],
      },
    ])
    expect(scopedDirs).toEqual(['/w/sub'])
    expect(changes).toBe(1)
  })

  it('does not store a prompt an agent sent to the pane (no humanPrompt on the caller)', async () => {
    await submit(hook('always run the deploy script'), human({ humanPrompt: undefined }))
    await submit(hook('always run the deploy script'), human({ humanPrompt: false }))
    expect(stored()).toEqual([])
  })

  it('stores nothing when the secret scan fails', async () => {
    redactFails = true
    await submit(hook('never add comments'))
    expect(stored()).toEqual([])
    expect(() => statSync(join(dir, SIGNALS_FILE))).toThrow()
    expect(changes).toBe(0)
  })

  it('stores nothing when the scan call throws', async () => {
    const throwing = signalCapture({
      signals,
      now: () => 5000,
      redact: async () => {
        throw new Error('no redactor')
      },
      workspace: async () => ({ kind: 'terminal', workDir: '/w' }),
      folderScopeOf: async () => where,
      confirmForget: async () => true,
      changed: () => {},
    })
    await throwing.onPrompt(hook('never add comments'), human())
    await throwing.settled()
    expect(stored()).toEqual([])
  })

  it('keeps the prompt with its secret removed', async () => {
    await submit(hook('log in with hunter2 and stop using mocks'))
    expect(stored().map((s) => s.text)).toEqual(['log in with [redacted] and stop using mocks'])
    expect(readFileSync(join(dir, SIGNALS_FILE), 'utf8')).not.toContain('hunter2')
  })

  it('writes the signals file for the owner only', async () => {
    await submit(hook('never add comments'))
    expect(statSync(join(dir, SIGNALS_FILE)).mode & 0o777).toBe(0o600)
  })

  it('keeps nothing from sandboxed, manager, remote, scratch or unknown workspaces', async () => {
    await submit(hook('one'), human({ sandboxed: true }))
    await submit(hook('two'), human({ manager: true }))
    await submit(hook('three'), human({ remote: { host: 'db1', cwd: '/srv' } }))
    await submit(hook('four'), human({ workspaceId: 'sc' }))
    await submit(hook('five'), human({ workspaceId: 'gone' }))
    expect(stored()).toEqual([])
  })

  it('keeps nothing from a user caller or a caller without a pane', async () => {
    await submit(hook('one'), { kind: 'user', humanPrompt: true, capabilities: [] })
    await submit(hook('two'), human({ paneId: undefined }))
    expect(stored()).toEqual([])
  })

  it('keeps nothing for other events, unknown agents, bad input or an empty prompt', async () => {
    await submit(hook('one', 'sess-1', 'Stop'))
    await submit(hook('two', 'sess-1', 'UserPromptSubmit', 'other'))
    await submit({ argv: ['claude', 'UserPromptSubmit'], stdin: 'not json' })
    await submit({ argv: ['claude', 'UserPromptSubmit'] })
    await submit({ argv: ['claude', 'UserPromptSubmit'], stdin: JSON.stringify({ prompt: 4 }) })
    await submit(hook('   '))
    await submit('nonsense')
    expect(stored()).toEqual([])
  })

  it('keeps nothing from a prompt longer than the limit, which is a paste and not a preference', async () => {
    await submit(hook('x'.repeat(PROMPT_MAX + 1)))
    expect(stored()).toEqual([])
    await submit(hook('x'.repeat(PROMPT_MAX)))
    expect(stored()).toHaveLength(1)
  })

  it('drops a session id it cannot trust and keeps the rest', async () => {
    await submit(hook('never add comments', 'bad id\nwith lines'))
    expect(stored()[0]?.session).toBe('')
  })

  it('stores a codex prompt', async () => {
    await submit(hook('prefer small functions', 'c-1', 'UserPromptSubmit', 'codex'))
    expect(stored()[0]).toMatchObject({ agent: 'codex', session: 'c-1' })
  })

  it('lists the newest first and deletes one', async () => {
    await submit(hook('first'))
    await submit(hook('second'))
    const listed = data<{ signals: { id: string; text: string }[] }>(
      await capture.panel.signals({}, human()),
    )
    expect(listed.signals.map((s) => s.text)).toEqual(['second', 'first'])
    expect((await capture.panel['delete-signal']({ id: 's1' }, human())).ok).toBe(true)
    expect(stored().map((s) => s.text)).toEqual(['second'])
    expect(await capture.panel['delete-signal']({ id: 's1' }, human())).toMatchObject({
      ok: false,
      error: 'not-found',
    })
  })

  it('forgets everything only after the human confirms', async () => {
    await submit(hook('first'))
    confirmAnswer = false
    await capture.panel['forget-signals']({}, human())
    expect(stored()).toHaveLength(1)
    confirmAnswer = true
    await capture.panel['forget-signals']({}, human())
    expect(stored()).toEqual([])
    expect(() => statSync(join(dir, SIGNALS_FILE))).toThrow()
  })
})
