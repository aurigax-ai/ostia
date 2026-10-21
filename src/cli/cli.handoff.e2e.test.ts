import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const userData = mkdtempSync(join(tmpdir(), 'ostia-handoff-approvals-'))
const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
  webContents: { fromId: () => ({ isDestroyed: () => false, send: () => {} }) },
}))

const { approvals, registerApprovals } = await import('../main/approvals/approvals')

import { registerControlServer, stopControlServer } from '../main/control/controlServer'
import { type PaneIdentity, registerPane } from '../main/control/idRegistry'
import { ExtensionExec } from '../main/extensions/extensionExec'
import { ExtensionHost } from '../main/extensions/extensionHost'
import { registerExtensionMethods } from '../main/extensions/extensionMethods'
import type { TerminalOpenRequest } from '../main/extensions/extensionRuns'
import { ExtensionStore } from '../main/extensions/extensionStore'
import { registerPaneListMethods } from '../main/panes/paneList'
import type { CommandResult } from '../shared/control/commands'

const repoRoot = process.cwd()
const cliPath = join(repoRoot, 'out', 'cli', 'index.js')
const human = { kind: 'human' }
const CALLER_SESSION = 'aaaa1111-2222-3333-4444-555566667777'
const OTHER_SESSION = 'cccc3333-2222-3333-4444-555566667777'

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

const projectKey = (folder: string): string => folder.replace(/[^A-Za-z0-9]/g, '-')

describe('ostia handoff (real extension process, real socket, real CLI)', () => {
  let dir: string
  let repo: string
  let socketPath: string
  let host: ExtensionHost
  let caller: PaneIdentity
  let opened: PaneIdentity
  let sandboxed: PaneIdentity
  let enabled = true
  const savedHome = process.env.HOME
  const openTerminalIn = vi.fn<(req: TerminalOpenRequest) => Promise<string | null>>()

  function ostia(identity: PaneIdentity, args: string[]): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        env: { ...process.env, OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token },
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`ostia ${args.join(' ')} timed out (${stdout} ${stderr})`))
      }, 20_000)
      child.stdout.on('data', (c: Buffer) => {
        stdout += c.toString()
      })
      child.stderr.on('data', (c: Buffer) => {
        stderr += c.toString()
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr })
      })
      child.stdin.on('error', () => {})
      child.stdin.end('')
    })
  }

  const session = (folder: string, id: string, lines: unknown[]): void => {
    const projects = join(dir, 'home', '.claude', 'projects', projectKey(folder))
    mkdirSync(projects, { recursive: true })
    writeFileSync(join(projects, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'))
  }
  const prompt = (text: string, cwd: string) => ({
    type: 'user',
    timestamp: '2026-10-21T01:00:00.000Z',
    cwd,
    origin: human,
    message: { content: text },
  })

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-cli-handoff-'))
    repo = join(dir, 'repo')
    mkdirSync(repo)
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.email', 'a@b.c'],
      ['config', 'user.name', 'Tester'],
      ['config', 'commit.gpgsign', 'false'],
    ]) {
      execFileSync('git', args, { cwd: repo })
    }
    writeFileSync(join(repo, 'cart.ts'), 'export const retry = 3\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'fix checkout retry loop'], { cwd: repo })
    session(repo, CALLER_SESSION, [
      { type: 'ai-title', aiTitle: 'Checkout retries' },
      prompt('the checkout retry loop is broken', repo),
      {
        type: 'assistant',
        timestamp: '2026-10-21T01:01:00.000Z',
        message: { content: [{ type: 'text', text: 'I will fix the checkout retry loop' }] },
      },
    ])
    session(join(dir, 'other'), OTHER_SESSION, [
      prompt('checkout retry in another project', join(dir, 'other')),
    ])
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'bin', 'gh'), '#!/bin/sh\nexit 1\n')
    chmodSync(join(dir, 'bin', 'gh'), 0o755)
    process.env.HOME = join(dir, 'home')
    socketPath = join(dir, 'control.sock')
    cpSync(join(repoRoot, 'out', 'extensions', 'handoff'), join(dir, 'builtin', 'handoff'), {
      recursive: true,
    })
    caller = registerPane({ windowId: 'w', workspaceId: 'w1', paneId: 'pHandoffCaller' })
    opened = registerPane({ windowId: 'w', workspaceId: 'w1', paneId: 'pHandoffOpened' })
    sandboxed = registerPane({ windowId: 'w', workspaceId: 'wsb', paneId: 'pHandoffSandboxed' })
    openTerminalIn.mockImplementation(async () => opened.externalId)
    const exec = new ExtensionExec({
      workspace: () => ({ workDir: repo }),
      wrap: async (_id, command) => command,
      sandboxEnv: (_id, env) => env,
      dataDir: () => join(dir, 'ext-data'),
      baseEnv: () => ({
        ...process.env,
        PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}`,
      }),
    })
    host = new ExtensionHost({
      sandboxDomains: () => null,
      isSandboxed: (id) => id === 'wsb',
      roots: [{ dir: join(dir, 'builtin'), builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      dataDir: join(dir, 'ext-data'),
      workDirForWorkspace: () => repo,
      broadcast: () => {},
      openPanelIn: () => {},
      notify: () => {},
      openTerminalIn,
      agentArgv: (name) => (name === 'claude' ? ['claude'] : null),
      agentNames: () => ['claude'],
      playbookEnabled: (id) => id === 'handoff' && enabled,
      exec,
      requestTimeoutMs: 1500,
      readyTimeoutMs: 8000,
      log: () => {},
    })
    registerExtensionMethods(() => host)
    registerApprovals(
      () => {},
      () => {},
      { opened: () => {}, settled: () => {} },
    )
    registerPaneListMethods({
      execCommand: async (_target, id) =>
        ({
          ok: true,
          result:
            id === 'workspace.list'
              ? [
                  {
                    workspaceId: 'w1',
                    name: 'shop',
                    kind: 'terminal',
                    workDir: repo,
                    state: 'idle',
                  },
                  {
                    workspaceId: 'wsb',
                    name: 'box',
                    kind: 'terminal',
                    workDir: repo,
                    state: 'idle',
                  },
                ]
              : [
                  {
                    paneId: 'pHandoffCaller',
                    workspaceId: 'w1',
                    kind: 'terminal',
                    title: 'claude',
                    agent: 'claude',
                    agentSessionId: CALLER_SESSION,
                  },
                  {
                    paneId: 'pHandoffOpened',
                    workspaceId: 'w1',
                    kind: 'terminal',
                    title: 'claude',
                    agent: 'claude',
                  },
                  {
                    paneId: 'pHandoffSandboxed',
                    workspaceId: 'wsb',
                    kind: 'terminal',
                    title: 'claude',
                    agent: 'claude',
                    agentSessionId: 'dddd4444-0000',
                  },
                ],
        }) as CommandResult,
      getTerminalState: () => undefined,
      ptyPid: () => undefined,
      windowIds: () => ['w'],
      waking: () => false,
    })
    registerControlServer(
      {
        execCommand: async () => ({ ok: true, result: null }) as CommandResult,
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
        isSandboxed: () => false,
      },
      socketPath,
    )
  }, 120_000)

  afterAll(() => {
    host.processes.stopAll()
    stopControlServer()
    if (savedHome === undefined) Reflect.deleteProperty(process.env, 'HOME')
    else process.env.HOME = savedHome
    rmSync(dir, { recursive: true, force: true })
  })

  it('hands a topic to a new tab beside the caller whose typed line carries only a ticket', async () => {
    const starting = ostia(caller, ['handoff', 'start', 'fix the checkout retry; $(rm -rf /)'])
    await vi.waitFor(() => expect(openTerminalIn).toHaveBeenCalledOnce(), { timeout: 10_000 })
    const req = openTerminalIn.mock.calls[0][0]
    const ticket = /intake (\w+)/.exec(req.command)?.[1] ?? ''
    expect(req).toMatchObject({ workspaceId: 'w1', afterPaneId: 'pHandoffCaller', asTab: true })
    expect(req.command).toBe(
      `claude 'Run ` +
        '`' +
        `ostia handoff intake ${ticket}` +
        '`' +
        ` and follow what it prints.'`,
    )
    expect(req.command).not.toContain('checkout')

    const wrong = await ostia(caller, ['handoff', 'intake', ticket])
    expect(wrong.code).not.toBe(0)
    expect(wrong.stderr).toContain('wrong-pane')

    const intake = await ostia(opened, ['handoff', 'intake', ticket])
    expect(intake.code).toBe(0)
    expect(intake.stdout).toContain('topic: fix the checkout retry; $(rm -rf /)')
    expect(intake.stdout).toContain(`claude session ${CALLER_SESSION}`)
    const again = await ostia(opened, ['handoff', 'intake', ticket])
    expect(again.stderr).toContain('claimed-ticket')

    const started = await starting
    expect(started.stderr).toBe('')
    expect(started.stdout).toContain(`handoff ${ticket} →`)
    expect(started.stdout).toContain('the new session read its steps')
  })

  it('finds the caller’s session first, reads it and gathers repository facts', async () => {
    const found = await ostia(opened, ['handoff', 'find', 'checkout retry'])
    expect(found.code).toBe(0)
    expect(found.stdout.split('\n')[0]).toContain(CALLER_SESSION)
    expect(found.stdout.split('\n')[0]).toContain('(the session that handed off)')
    expect(found.stdout).not.toContain(OTHER_SESSION)

    const timeline = await ostia(opened, ['handoff', 'timeline', 'aaaa1111'])
    expect(timeline.stdout).toContain('# session aaaa1111')
    expect(timeline.stdout).toContain('USER: the checkout retry loop is broken')

    const gathered = await ostia(opened, ['handoff', 'gather', 'checkout retry'])
    expect(gathered.stdout).toContain('fix checkout retry loop')
    expect(gathered.stdout).toContain('cart.ts')
  })

  it('reaches other projects only through a card the human answers, even after the command timeout', async () => {
    const elsewhere = await ostia(opened, ['handoff', 'timeline', 'cccc3333'])
    expect(elsewhere.stderr).toContain('unknown-session')
    expect(elsewhere.stderr).not.toContain(OTHER_SESSION)

    const pending = (): number => approvals()?.stateFor('w').pending.length ?? 0
    const answer = (choice: string): unknown => {
      const id = approvals()?.stateFor('w').pending[0]?.id
      return handlers.get('approvals:answer')?.(
        { sender: { id: 'w', getType: () => 'window' } },
        id,
        choice,
      )
    }

    const refused = ostia(opened, ['handoff', 'find', 'checkout', '--all'])
    await vi.waitFor(() => expect(pending()).toBe(1), { timeout: 10_000 })
    answer('deny')
    const denied = await refused
    expect(denied.code).not.toBe(0)
    expect(denied.stderr).toContain('denied')
    expect(denied.stdout).not.toContain(OTHER_SESSION)

    const allowed = ostia(opened, ['handoff', 'find', 'checkout', '--all'])
    await vi.waitFor(() => expect(pending()).toBe(1), { timeout: 10_000 })
    await new Promise((resolve) => setTimeout(resolve, 2500))
    answer('once')
    const found = await allowed
    expect(found.stderr).toBe('')
    expect(found.stdout).toContain(OTHER_SESSION)

    const reading = ostia(opened, ['handoff', 'timeline', 'cccc3333', '--all'])
    await vi.waitFor(() => expect(pending()).toBe(1), { timeout: 10_000 })
    answer('once')
    const timeline = await reading
    expect(timeline.stdout).toContain('checkout retry in another project')
  }, 60_000)

  it('refuses a sandboxed caller and everything while the playbook is off', async () => {
    const box = await ostia(sandboxed, ['handoff', 'start', 'anything'])
    expect(box.code).not.toBe(0)
    expect(box.stderr).toContain('sandboxed')
    enabled = false
    for (const args of [
      ['start', 'x'],
      ['find', 'checkout'],
      ['gather', 'checkout'],
    ]) {
      const off = await ostia(caller, ['handoff', ...args])
      expect(off.code).not.toBe(0)
      expect(off.stderr).toContain('playbook-off')
    }
    enabled = true
    expect(openTerminalIn).not.toHaveBeenCalled()
  })
})
