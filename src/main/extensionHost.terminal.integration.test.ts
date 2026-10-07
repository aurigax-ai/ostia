import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionCaller } from '../shared/extensions'
import type { CommandResult } from '../shared/types'
import { registerControlServer, stopControlServer } from './controlServer'
import {
  type ExtensionConfirmRequest,
  ExtensionHost,
  type TerminalOpenRequest,
  registerExtensionMethods,
} from './extensionHost'
import { ExtensionStore } from './extensionStore'
import { type PaneIdentity, registerPane } from './idRegistry'

const fixtures = resolve(__dirname, '../../test/fixtures/extensions-terminal')
const REQUEST_TIMEOUT_MS = 300

const caller: ExtensionCaller = { kind: 'user', workspaceId: 'w1', capabilities: [] }

describe('ExtensionHost ext.openTerminal and interactive commands (real socket)', () => {
  let dir: string
  let host: ExtensionHost
  let agentPane: PaneIdentity
  const confirm = vi.fn<(req: ExtensionConfirmRequest) => Promise<boolean>>()
  const openTerminalIn = vi.fn<(req: TerminalOpenRequest) => Promise<string | null>>()

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-ext-terminal-'))
    const socketPath = join(dir, 'control.sock')
    agentPane = registerPane({ windowId: '7', workspaceId: 'w1', paneId: 'pane-agent' })
    registerPane({ windowId: '7', workspaceId: 'w2', paneId: 'pane-other' })
    host = new ExtensionHost({
      roots: [{ dir: fixtures, builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: () => undefined,
      broadcast: () => {},
      openPanelIn: () => {},
      notify: () => {},
      confirm,
      openTerminalIn,
      readyTimeoutMs: 8000,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      interactiveTimeoutMs: 8000,
      log: () => {},
    })
    registerExtensionMethods(() => host)
    registerControlServer(
      {
        execCommand: async () => ({ ok: true, result: null }) as CommandResult,
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
      },
      socketPath,
    )
  })

  afterAll(() => {
    host.stopAll()
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    confirm.mockReset()
    openTerminalIn.mockReset()
  })

  it('quotes the argv once and opens beside the named pane in its own workspace', async () => {
    openTerminalIn.mockResolvedValue('new-external-id')
    const res = await host.invoke(
      'opener',
      'open',
      {
        command: ['printf', '%s\\n', "it's $HOME"],
        afterPaneId: agentPane.externalId,
        cwd: '/tmp',
        title: 'Install',
      },
      caller,
    )
    expect(res).toEqual({ ok: true, data: { ok: true, paneId: 'new-external-id' } })
    expect(openTerminalIn).toHaveBeenCalledWith({
      command: `printf '%s\\n' 'it'\\''s $HOME'`,
      afterPaneId: 'pane-agent',
      workspaceId: 'w1',
      windowId: '7',
      cwd: '/tmp',
      title: 'Install',
    })
  })

  it('refuses bad requests without opening anything', async () => {
    const attempts: unknown[] = [
      { command: [] },
      { command: 'sudo rm -rf /' },
      { command: ['echo', 'a\nreboot'] },
      { command: ['', 'x'] },
      { command: ['echo'], cwd: 'relative/dir' },
      { command: ['echo'], afterPaneId: 'no-such-pane' },
      { command: ['echo'], afterPaneId: agentPane.externalId, workspaceId: 'w2' },
      { command: ['echo'], waitMs: 0 },
      { command: ['echo'], waitMs: '5000' },
    ]
    for (const args of attempts) {
      const res = await host.invoke('opener', 'open', args, caller)
      expect(res).toMatchObject({ ok: true, data: { ok: false } })
    }
    expect(openTerminalIn).not.toHaveBeenCalled()
  })

  async function openAndWait(paneId: string, waitMs: number) {
    openTerminalIn.mockResolvedValue(paneId)
    const result = host.invoke('opener', 'open', { command: ['sudo', 'true'], waitMs }, caller)
    await vi.waitFor(() => expect(openTerminalIn).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 30))
    return { result }
  }

  it('waits for the command it opened to finish and returns its exit code', async () => {
    const { result } = await openAndWait('pane-install', 5000)
    host.emitEvent('command.finished', { paneId: 'other-pane', workspaceId: 'w1', exitCode: 9 })
    host.emitEvent('command.finished', { paneId: 'pane-install', workspaceId: 'w1', exitCode: 0 })
    expect(await result).toEqual({
      ok: true,
      data: { ok: true, paneId: 'pane-install', wait: { outcome: 'finished', exitCode: 0 } },
    })
  })

  it('stops waiting when the human closes that terminal', async () => {
    const { result } = await openAndWait('pane-closed-early', 5000)
    host.emitEvent('pane.closed', { paneId: 'pane-closed-early', workspaceId: 'w1' })
    expect(await result).toMatchObject({ data: { wait: { outcome: 'closed' } } })
  })

  it('answers timeout when the command is still running after the wait', async () => {
    const { result } = await openAndWait('pane-slow', 100)
    expect(await result).toMatchObject({
      data: { ok: true, paneId: 'pane-slow', wait: { outcome: 'timeout' } },
    })
  })

  it('reports not-opened when no window takes the terminal', async () => {
    openTerminalIn.mockResolvedValue(null)
    const res = await host.invoke('opener', 'open', { command: ['true'] }, caller)
    expect(res).toMatchObject({ ok: true, data: { ok: false, error: 'not-opened' } })
  })

  it('refuses an extension without the shell capability at the socket', async () => {
    const res = await host.invoke('noshell', 'open', { command: ['true'] }, caller)
    expect(res).toMatchObject({ ok: false, error: 'rpc', message: 'needs-elevation: shell' })
    expect(openTerminalIn).not.toHaveBeenCalled()
  })

  it('waits past the request timeout for an interactive command, not for a plain one', async () => {
    const slowAnswer = (): Promise<boolean> =>
      new Promise((r) => setTimeout(() => r(true), REQUEST_TIMEOUT_MS * 3))
    confirm.mockImplementation(slowAnswer)
    const plain = await host.invoke('opener', 'ask-plain', null, caller)
    expect(plain).toMatchObject({ ok: false, error: 'extension-unavailable' })

    confirm.mockImplementation(slowAnswer)
    const interactive = await host.invoke('opener', 'ask', null, caller)
    expect(interactive).toEqual({ ok: false, error: 'answered', data: { confirmed: true } })
  })
})
