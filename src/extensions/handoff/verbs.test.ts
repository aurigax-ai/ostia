import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ExtensionCaller,
  ExtensionResult,
  OstiaExtension,
  PaneInfo,
} from '@aurigax-ai/ostia-extension-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectKey } from './sessionFiles'
import { Tickets } from './tickets'
import { handoffVerbs } from './verbs'

const human = { kind: 'human' }

function caller(extra: Partial<ExtensionCaller> = {}): ExtensionCaller {
  return {
    kind: 'pane',
    paneId: 'p1',
    workspaceId: 'w1',
    workDir: '/home/u/app',
    cwd: '/home/u/app',
    capabilities: ['read-board'],
    ...extra,
  }
}

const AGENT_PANE: PaneInfo = {
  paneId: 'p1',
  workspaceId: 'w1',
  kind: 'terminal',
  title: 'claude',
  running: true,
  blockCount: 0,
  agent: 'claude',
  agentSessionId: 'aaaa1111-0000',
}

const NEW_PANE: PaneInfo = {
  ...AGENT_PANE,
  paneId: 'p2abcdef0123',
  agentSessionId: 'bbbb9999-0000',
}

describe('ostia handoff verbs', () => {
  let projects: string
  let tickets: Tickets
  let panes: PaneInfo[]
  let workspaceKind: string
  let enabled: boolean
  let caps: { ok: true } | { ok: false; error: string; message?: string }
  const runAgent = vi.fn()
  const exec = vi.fn()
  const requireCallerCaps = vi.fn()

  const verbs = () =>
    handoffVerbs({
      ext: {
        playbookEnabled: async () => enabled,
        listPanes: async () => panes,
        listWorkspaces: async () => [
          {
            workspaceId: 'w1',
            name: 'app',
            kind: workspaceKind,
            workDir: '/home/u/app',
            state: 'open',
          },
        ],
        runAgent,
        exec,
        requireCallerCaps,
      } as unknown as Pick<
        OstiaExtension,
        | 'listPanes'
        | 'listWorkspaces'
        | 'runAgent'
        | 'exec'
        | 'requireCallerCaps'
        | 'playbookEnabled'
      >,
      tickets,
      projectsDir: projects,
      confirmMs: 40,
      pollMs: 5,
    })
  const run = (verb: string, argv: string[], who = caller()): Promise<ExtensionResult> =>
    Promise.resolve(verbs()[verb]?.({ argv }, who)) as Promise<ExtensionResult>
  const text = (res: ExtensionResult): string => (res as { text: string }).text
  const error = (res: ExtensionResult): string => (res as { error: string }).error

  const session = (folder: string, id: string, lines: unknown[]): void => {
    const dir = join(projects, projectKey(folder))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'))
  }
  const prompt = (words: string) => ({
    type: 'user',
    timestamp: '2026-10-21T01:00:00.000Z',
    cwd: '/home/u/app',
    origin: human,
    message: { content: words },
  })

  beforeEach(() => {
    projects = mkdtempSync(join(tmpdir(), 'ostia-handoff-verbs-'))
    let n = 0
    tickets = new Tickets({ now: Date.now, newId: () => `t${++n}`, waitMs: 20 })
    panes = [AGENT_PANE, NEW_PANE]
    workspaceKind = 'terminal'
    enabled = true
    caps = { ok: true }
    runAgent.mockReset().mockResolvedValue({ ok: true, paneId: 'p2abcdef0123' })
    exec.mockReset().mockResolvedValue({ ok: false, error: 'spawn-failed' })
    requireCallerCaps.mockReset().mockImplementation(async () => caps)
    session('/home/u/app', 'aaaa1111-0000', [prompt('checkout retry loop is broken')])
    session('/home/u/app', 'bbbb2222-0000', [prompt('checkout retry earlier try')])
    session('/home/u/other', 'cccc3333-0000', [prompt('checkout retry in another project')])
  })

  afterEach(() => {
    rmSync(projects, { recursive: true, force: true })
  })

  describe('start', () => {
    it('opens the new agent right after the caller with a fixed prompt that names only a ticket', async () => {
      const res = await run('start', ['fix the checkout retry; $(rm -rf /)'])
      expect(res.ok).toBe(true)
      expect(text(res)).toBe(
        'handoff t1 → p2abcdef started (the agent is running); this session is unchanged',
      )
      expect(runAgent).toHaveBeenCalledWith({
        workspaceId: 'w1',
        agent: 'claude',
        prompt: 'Run `ostia handoff intake t1` and follow what it prints.',
        afterPaneId: 'p1',
      })
    })

    it('works from the palette on the active pane', async () => {
      const res = await run('start', ['checkout'], caller({ kind: 'user' }))
      expect(res.ok).toBe(true)
      expect(runAgent).toHaveBeenCalledOnce()
    })

    it('answers with usage when the topic is empty', async () => {
      expect(error(await run('start', ['  ']))).toBe('usage')
      expect(runAgent).not.toHaveBeenCalled()
    })

    interface Refusal {
      name: string
      code: string
      setup?: () => void
      extra?: Partial<ExtensionCaller>
    }
    const refusals: Refusal[] = [
      {
        name: 'playbook off',
        code: 'playbook-off',
        setup: () => {
          enabled = false
        },
      },
      { name: 'sandboxed', code: 'sandboxed', extra: { sandboxed: true } },
      { name: 'manager', code: 'manager', extra: { manager: true } },
      { name: 'remote', code: 'remote', extra: { remote: { host: 'h', path: '/p' } as never } },
      {
        name: 'scratch',
        code: 'scratch',
        setup: () => {
          workspaceKind = 'scratch'
        },
      },
      {
        name: 'no agent',
        code: 'no-session',
        setup: () => {
          panes = [{ ...AGENT_PANE, agent: undefined }]
        },
      },
      {
        name: 'no session id',
        code: 'no-session',
        setup: () => {
          panes = [{ ...AGENT_PANE, agentSessionId: undefined }]
        },
      },
      {
        name: 'manager pane',
        code: 'no-session',
        setup: () => {
          panes = [{ ...AGENT_PANE, kind: 'manager' }]
        },
      },
      {
        name: 'codex',
        code: 'unsupported-agent',
        setup: () => {
          panes = [{ ...AGENT_PANE, agent: 'codex' }]
        },
      },
      {
        name: 'unknown pane',
        code: 'no-session',
        setup: () => {
          panes = []
        },
      },
    ]

    it.each(refusals)('refuses $name and opens nothing', async ({ setup, code, extra }) => {
      setup?.()
      const res = await run('start', ['checkout'], caller(extra))
      expect(error(res)).toBe(code)
      expect(runAgent).not.toHaveBeenCalled()
    })

    it('says not-confirmed when the new tab never starts an agent session, and keeps the ticket', async () => {
      panes = [AGENT_PANE]
      const res = await run('start', ['checkout'])
      expect(error(res)).toBe('not-confirmed')
      expect((res as { message: string }).message).toContain('t1 → p2abcdef')
      expect((await tickets.claim('t1', 'p2abcdef0123')).ok).toBe(true)
    })

    it('confirms from the new session reading its steps', async () => {
      panes = [AGENT_PANE]
      const started = run('start', ['checkout'])
      await new Promise((resolve) => setTimeout(resolve, 10))
      await run('intake', ['t1'], caller({ paneId: 'p2abcdef0123' }))
      expect(text(await started)).toContain('(the new session read its steps)')
    })

    it('forgets the ticket when the agent cannot start', async () => {
      runAgent.mockResolvedValue({ ok: false, error: 'rate-limited', message: 'too many' })
      expect(error(await run('start', ['checkout']))).toBe('not-started')
      expect((await tickets.claim('t1', 'p2abcdef0123')).ok).toBe(false)
    })
  })

  describe('intake', () => {
    it('prints the steps once, only to the pane the start opened', async () => {
      await run('start', ['checkout retry'])
      const wrong = await run('intake', ['t1'], caller({ paneId: 'p9' }))
      expect(error(wrong)).toBe('wrong-pane')
      const opened = caller({ paneId: 'p2abcdef0123' })
      const res = await run('intake', ['t1'], opened)
      expect(res.ok).toBe(true)
      expect(text(res)).toContain('topic: checkout retry')
      expect(text(res)).toContain('session aaaa1111-0000')
      expect(error(await run('intake', ['t1'], opened))).toBe('claimed-ticket')
    })

    it('answers usage without a ticket and refuses a palette caller', async () => {
      expect(error(await run('intake', []))).toBe('usage')
      expect(error(await run('intake', ['t1'], caller({ kind: 'user' })))).toBe('not-available')
    })
  })

  describe('find', () => {
    it('ranks the folder’s sessions and leaves other projects out', async () => {
      const res = await run('find', ['checkout', 'retry'])
      const ids = text(res)
        .split('\n')
        .map((l) => l.split(' ')[0])
      expect(ids.sort()).toEqual(['aaaa1111-0000', 'bbbb2222-0000'])
      expect(requireCallerCaps).not.toHaveBeenCalled()
    })

    it('lists the handing-off session first for the pane that claimed the ticket', async () => {
      await run('start', ['checkout'])
      await run('intake', ['t1'], caller({ paneId: 'p2abcdef0123' }))
      const res = await run('find', ['earlier'], caller({ paneId: 'p2abcdef0123' }))
      const first = text(res).split('\n')[0]
      expect(first).toContain('aaaa1111-0000')
      expect(first).toContain('(the session that handed off)')
    })

    it('does not follow the pane’s reported folder into another project', async () => {
      const res = await run('find', ['checkout'], caller({ cwd: '/home/u/other' }))
      expect(text(res)).not.toContain('cccc3333-0000')
      expect(requireCallerCaps).not.toHaveBeenCalled()
    })

    it('searches every project only after the caller’s all-workspaces answer', async () => {
      const res = await run('find', ['checkout', '--all'])
      expect(requireCallerCaps).toHaveBeenCalledWith('p1', ['all-workspaces'], expect.any(String))
      expect(text(res)).toContain('cccc3333-0000')
    })

    it('stops when the human denies the card', async () => {
      caps = { ok: false, error: 'denied', message: 'denied: all-workspaces' }
      const res = await run('find', ['checkout', '--all'])
      expect(error(res)).toBe('denied')
    })

    it('needs words and refuses unknown options', async () => {
      expect(error(await run('find', []))).toBe('usage')
      expect(error(await run('find', ['x', '--wide']))).toBe('usage')
    })

    it.each([
      ['sandboxed', { sandboxed: true }, 'sandboxed'],
      ['manager', { manager: true }, 'manager'],
      ['palette', { kind: 'user' as const }, 'not-available'],
    ])('refuses a %s caller', async (_name, extra, code) => {
      expect(error(await run('find', ['checkout'], caller(extra)))).toBe(code)
    })

    it('refuses everything while the playbook is off', async () => {
      enabled = false
      for (const verb of ['find', 'timeline', 'gather', 'intake']) {
        expect(error(await run(verb, ['aaaa1111']))).toBe('playbook-off')
      }
    })
  })

  describe('timeline', () => {
    it('prints sessions of the folder oldest first', async () => {
      const res = await run('timeline', ['aaaa1111', 'bbbb2222'])
      expect(text(res)).toContain('# session aaaa1111-0000')
      expect(text(res)).toContain('USER: checkout retry loop is broken')
      expect(requireCallerCaps).not.toHaveBeenCalled()
    })

    it('refuses a session of another project unless --all is answered', async () => {
      expect(error(await run('timeline', ['cccc3333']))).toBe('unknown-session')
      const res = await run('timeline', ['cccc3333', '--all'])
      expect(requireCallerCaps).toHaveBeenCalledOnce()
      expect(text(res)).toContain('# session cccc3333-0000')
    })

    it('refuses an id prefix that matches more than one session instead of picking one', async () => {
      session('/home/u/app', 'aaaa2222-0000', [prompt('another one')])
      const res = await run('timeline', ['aaaa'])
      expect(error(res)).toBe('ambiguous-session')
      expect((res as { message: string }).message).toContain('aaaa1111-0000')
      expect((await run('timeline', ['aaaa1111'])).ok).toBe(true)
    })

    it('stops on a denied card and on an unknown or malformed id', async () => {
      caps = { ok: false, error: 'not-approved', message: 'not-approved: all-workspaces' }
      expect(error(await run('timeline', ['cccc3333', '--all']))).toBe('not-approved')
      expect(error(await run('timeline', ['dddd4444']))).toBe('unknown-session')
      expect(error(await run('timeline', ['../etc']))).toBe('usage')
      expect(error(await run('timeline', []))).toBe('usage')
    })
  })

  describe('gather', () => {
    it('runs the sources in the caller’s workspace', async () => {
      await run('gather', ['checkout', 'retry'])
      expect(exec).toHaveBeenCalled()
      expect(exec.mock.calls.every(([opts]) => opts.workspaceId === 'w1')).toBe(true)
      expect(exec.mock.calls.every(([opts]) => Array.isArray(opts.command))).toBe(true)
    })

    it('needs words', async () => {
      expect(error(await run('gather', []))).toBe('usage')
    })
  })
})
