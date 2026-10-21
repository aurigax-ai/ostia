import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  EXTENSION_REDACT_TEXT_MAX,
  EXTENSION_REDACT_TEXTS_MAX,
  type ExtensionCaller,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { ExtensionAgentOffer } from '@aurigax-ai/ostia-extension-sdk/contract/extensionsBridge'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '../../shared/control/commands'
import type { RedactionResult } from '../../shared/privacy/redaction'
import {
  AGENT_TASKS_PER_MINUTE,
  type AgentOfferDelivery,
  REACHED_PANES_MAX,
} from '../agents/extensionAgents'
import { registerControlServer, stopControlServer } from '../control/controlServer'
import { type PaneIdentity, registerPane, removePane } from '../control/idRegistry'
import { ExtensionHost } from './extensionHost'
import { registerExtensionMethods } from './extensionMethods'
import type { TerminalOpenRequest } from './extensionRuns'
import { ExtensionStore } from './extensionStore'

const fixtures = resolve(__dirname, '../../../test/fixtures/extensions-agents')
const caller: ExtensionCaller = { kind: 'user', workspaceId: 'w1', capabilities: [] }

type Offer = Omit<ExtensionAgentOffer, 'requestId'>

describe('ExtensionHost agent tasks: ext.agents, ext.runAgent, ext.offerToAgent, ext.focusPane', () => {
  let dir: string
  let host: ExtensionHost
  let clock = 0
  let opened: PaneIdentity
  let picked: PaneIdentity
  let stranger: PaneIdentity
  const openTerminalIn = vi.fn<(req: TerminalOpenRequest) => Promise<string | null>>()
  const offerToAgentIn = vi.fn<(offer: Offer) => Promise<AgentOfferDelivery>>()
  const focusPaneIn = vi.fn<(pane: PaneIdentity) => boolean>()
  const redact = vi.fn<(text: string) => Promise<RedactionResult>>()

  const call = async (
    extId: string,
    method: string,
    params?: unknown,
    servingPane?: PaneIdentity,
  ) => {
    const who = servingPane ? { ...caller, paneId: servingPane.externalId } : caller
    const res = await host.invoke(extId, 'call', { method, params }, who)
    if (!res.ok) return { rpcError: res.message }
    return res.data as Record<string, unknown>
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-ext-agents-'))
    const socketPath = join(dir, 'control.sock')
    opened = registerPane({ windowId: '7', workspaceId: 'w1', paneId: 'pane-opened' })
    picked = registerPane({ windowId: '7', workspaceId: 'w1', paneId: 'pane-picked' })
    stranger = registerPane({ windowId: '7', workspaceId: 'w1', paneId: 'pane-stranger' })
    host = new ExtensionHost({
      sandboxDomains: () => null,
      isSandboxed: () => false,
      roots: [{ dir: fixtures, builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: (id) => (id === 'w1' ? '~/shop' : undefined),
      broadcast: () => {},
      openPanelIn: () => {},
      notify: () => {},
      openTerminalIn,
      offerToAgentIn,
      focusPaneIn,
      redact,
      agentArgv: (name) => ({ claude: ['claude'], codex: ['codex', '--full-auto'] })[name] ?? null,
      agentNames: () => ['claude', 'codex'],
      agentTaskClock: () => clock,
      playbookEnabled: (id) => id === 'tasker',
      readyTimeoutMs: 8000,
      interactiveTimeoutMs: 8000,
      log: () => {},
    })
    registerExtensionMethods(() => host)
    registerControlServer(
      {
        execCommand: async () => ({ ok: true, result: null }) as CommandResult,
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
        isSandboxed: () => false,
      },
      socketPath,
    )
  })

  afterAll(() => {
    host.processes.stopAll()
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    clock += 120_000
    openTerminalIn.mockReset()
    offerToAgentIn.mockReset()
    focusPaneIn.mockReset()
    redact.mockReset()
  })

  it('redacts an extension’s texts with main’s redactor and never hands back a text it could not scan', async () => {
    redact.mockImplementation(async (text) => ({
      text: text.replaceAll('hunter2', '[redacted]'),
      count: 1,
      kinds: {},
    }))
    expect(await call('tasker', 'ext.redact', { texts: ['pw hunter2', '', 'plain'] })).toEqual({
      ok: true,
      texts: ['pw [redacted]', '', 'plain'],
    })
    redact.mockRejectedValue(new Error('scan died'))
    const failed = await call('tasker', 'ext.redact', { texts: ['pw hunter2'] })
    expect(failed).toMatchObject({ ok: false, error: 'redaction-failed' })
    expect(JSON.stringify(failed)).not.toContain('hunter2')
    redact.mockClear()
    const refused: unknown[] = [
      {},
      { texts: 'pw' },
      { texts: [4] },
      { texts: Array.from({ length: EXTENSION_REDACT_TEXTS_MAX + 1 }, () => 'a') },
      { texts: ['a'.repeat(EXTENSION_REDACT_TEXT_MAX + 1)] },
    ]
    for (const params of refused) {
      expect(await call('tasker', 'ext.redact', params)).toMatchObject({
        ok: false,
        error: 'invalid-params',
      })
    }
    expect(redact).not.toHaveBeenCalled()
  })

  it('lists only the names of the agents it may run', async () => {
    expect(await call('tasker', 'ext.agents')).toEqual({ ok: true, agents: ['claude', 'codex'] })
  })

  it('runs the agent argv with the prompt as one quoted argument in a new terminal of that workspace', async () => {
    openTerminalIn.mockResolvedValue(opened.externalId)
    const res = await call('tasker', 'ext.runAgent', {
      workspaceId: 'w1',
      agent: 'codex',
      prompt: "Fix it; don't `rm -rf` $HOME\nthen comment",
    })
    expect(res).toEqual({ ok: true, paneId: opened.externalId })
    expect(openTerminalIn).toHaveBeenCalledWith({
      command: `codex --full-auto 'Fix it; don'\\''t \`rm -rf\` $HOME\nthen comment'`,
      workspaceId: 'w1',
      cwd: join(homedir(), 'shop'),
    })
  })

  it('refuses a run without a workspace, a known agent or a clean prompt, opening nothing', async () => {
    const attempts: [unknown, string][] = [
      [{ agent: 'claude', prompt: 'x' }, 'invalid-params'],
      [{ workspaceId: 'w1', agent: 'claude --yolo', prompt: 'x' }, 'invalid-params'],
      [{ workspaceId: 'w1', agent: 'gemini', prompt: 'x' }, 'unknown-agent'],
      [{ workspaceId: 'w1', agent: 'claude', prompt: '   ' }, 'invalid-params'],
      [{ workspaceId: 'w1', agent: 'claude', prompt: 'go\x1b[201~\r' }, 'invalid-params'],
      [{ workspaceId: 'w1', agent: 'claude', prompt: 'x'.repeat(16_001) }, 'invalid-params'],
    ]
    for (const [params, error] of attempts) {
      expect(await call('tasker', 'ext.runAgent', params), JSON.stringify(params)).toMatchObject({
        ok: false,
        error,
      })
    }
    expect(openTerminalIn).not.toHaveBeenCalled()
  })

  it('refuses ext.agents and ext.runAgent to an extension without shell', async () => {
    expect(await call('plain', 'ext.agents')).toEqual({ rpcError: 'needs-elevation: shell' })
    expect(
      await call('plain', 'ext.runAgent', { workspaceId: 'w1', agent: 'claude', prompt: 'x' }),
    ).toEqual({ rpcError: 'needs-elevation: shell' })
    expect(openTerminalIn).not.toHaveBeenCalled()
  })

  it('opens the agent as a tab right after the pane its command is serving, taking focus', async () => {
    openTerminalIn.mockResolvedValue(picked.externalId)
    const res = await call(
      'tasker',
      'ext.runAgent',
      { workspaceId: 'w1', agent: 'claude', prompt: 'go', afterPaneId: opened.externalId },
      opened,
    )
    expect(res).toEqual({ ok: true, paneId: picked.externalId })
    expect(openTerminalIn).toHaveBeenCalledWith({
      command: 'claude go',
      workspaceId: 'w1',
      cwd: join(homedir(), 'shop'),
      afterPaneId: 'pane-opened',
      windowId: '7',
      asTab: true,
      humanCall: true,
    })
  })

  it('refuses afterPaneId for a pane the extension is not serving, a background run or another workspace', async () => {
    const run = { workspaceId: 'w1', agent: 'claude', prompt: 'go' }
    expect(
      await call('tasker', 'ext.runAgent', { ...run, afterPaneId: stranger.externalId }, opened),
    ).toMatchObject({ ok: false, error: 'not-reached' })
    expect(
      await call('tasker', 'ext.runAgent', { ...run, afterPaneId: opened.externalId }),
    ).toMatchObject({ ok: false, error: 'not-reached' })
    expect(
      await call(
        'tasker',
        'ext.runAgent',
        { ...run, afterPaneId: opened.externalId, background: true },
        opened,
      ),
    ).toMatchObject({ ok: false, error: 'invalid-params' })
    expect(
      await call(
        'tasker',
        'ext.runAgent',
        { ...run, workspaceId: 'w2', afterPaneId: opened.externalId },
        opened,
      ),
    ).toMatchObject({ ok: false, error: 'unknown-pane' })
    expect(openTerminalIn).not.toHaveBeenCalled()
  })

  it('asks the caller’s capability only for the pane whose command line call it is serving', async () => {
    expect(
      await call('tasker', 'ext.requireCallerCaps', {
        paneId: opened.externalId,
        caps: ['all-workspaces'],
        reason: 'read every project',
      }),
    ).toMatchObject({ ok: false, error: 'not-reached' })
    expect(
      await call(
        'tasker',
        'ext.requireCallerCaps',
        { paneId: opened.externalId, caps: ['all-workspaces'], reason: 'read every project' },
        opened,
      ),
    ).toMatchObject({ ok: false, error: 'not-reached' })
    const refused: unknown[] = [
      { paneId: opened.externalId, caps: ['kill-pane'], reason: 'x' },
      { paneId: opened.externalId, caps: [], reason: 'x' },
      { paneId: opened.externalId, caps: ['all-workspaces'], reason: '' },
      { paneId: opened.externalId, caps: ['all-workspaces'], reason: 'a\u0000b' },
    ]
    for (const params of refused) {
      expect(await call('tasker', 'ext.requireCallerCaps', params, opened)).toMatchObject({
        ok: false,
        error: 'invalid-params',
      })
    }
  })

  it('tells a built-in only whether its own playbook is on', async () => {
    expect(await call('tasker', 'ext.playbookEnabled')).toEqual({ ok: true, enabled: true })
    expect(await call('plain', 'ext.playbookEnabled')).toEqual({ ok: true, enabled: false })
  })

  it('hands the human one line to pick an agent for and says which pane got it', async () => {
    offerToAgentIn.mockResolvedValue({ delivered: true, paneId: picked.externalId })
    const res = await call('plain', 'ext.offerToAgent', {
      workspaceId: 'w1',
      label: 'SHOP-7 · Fix the cart',
      text: 'Work on SHOP-7',
    })
    expect(res).toEqual({ ok: true, sent: true, paneId: picked.externalId })
    expect(offerToAgentIn).toHaveBeenCalledWith({
      extId: 'plain',
      extName: 'Plain',
      workspaceId: 'w1',
      label: 'SHOP-7 · Fix the cart',
      text: 'Work on SHOP-7',
    })
  })

  it('never lets an offer carry Enter or another control character', async () => {
    for (const text of ['go\r', 'go\nrm -rf ~', 'go\x1b[201~', 'tab\there', 'x'.repeat(2001), '']) {
      expect(
        await call('tasker', 'ext.offerToAgent', { workspaceId: 'w1', label: 'L', text }),
        JSON.stringify(text),
      ).toMatchObject({ ok: false, error: 'invalid-params' })
    }
    expect(
      await call('tasker', 'ext.offerToAgent', { workspaceId: 'w1', label: 'a\nb', text: 'ok' }),
    ).toMatchObject({ ok: false, error: 'invalid-params' })
    expect(offerToAgentIn).not.toHaveBeenCalled()
  })

  it('reports a dismissed offer as not sent and a workspace no window holds as unknown', async () => {
    offerToAgentIn.mockResolvedValueOnce({ delivered: true, paneId: null })
    expect(
      await call('tasker', 'ext.offerToAgent', { workspaceId: 'w1', label: 'L', text: 'go' }),
    ).toEqual({ ok: true, sent: false })
    offerToAgentIn.mockResolvedValueOnce({ delivered: false })
    expect(
      await call('tasker', 'ext.offerToAgent', { workspaceId: 'gone', label: 'L', text: 'go' }),
    ).toMatchObject({ ok: false, error: 'unknown-workspace' })
  })

  it('keeps one offer waiting at a time per extension', async () => {
    let release: (d: AgentOfferDelivery) => void = () => {}
    offerToAgentIn.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r
        }),
    )
    const first = call('tasker', 'ext.offerToAgent', { workspaceId: 'w1', label: 'L', text: 'a' })
    await vi.waitFor(() => expect(offerToAgentIn).toHaveBeenCalledTimes(1))
    expect(
      await call('tasker', 'ext.offerToAgent', { workspaceId: 'w1', label: 'L', text: 'b' }),
    ).toMatchObject({ ok: false, error: 'busy' })
    release({ delivered: true, paneId: null })
    expect(await first).toEqual({ ok: true, sent: false })
  })

  it('rate-limits offers and runs together, per extension, per minute', async () => {
    offerToAgentIn.mockResolvedValue({ delivered: true, paneId: null })
    openTerminalIn.mockResolvedValue(opened.externalId)
    for (let i = 0; i < AGENT_TASKS_PER_MINUTE; i++) {
      const res =
        i % 2 === 0
          ? await call('tasker', 'ext.offerToAgent', { workspaceId: 'w1', label: 'L', text: 'go' })
          : await call('tasker', 'ext.runAgent', {
              workspaceId: 'w1',
              agent: 'claude',
              prompt: 'go',
            })
      expect(res).toMatchObject({ ok: true })
    }
    expect(
      await call('tasker', 'ext.runAgent', { workspaceId: 'w1', agent: 'claude', prompt: 'go' }),
    ).toMatchObject({ ok: false, error: 'rate-limited' })
    expect(
      await call('tasker', 'ext.offerToAgent', { workspaceId: 'w1', label: 'L', text: 'go' }),
    ).toMatchObject({ ok: false, error: 'rate-limited' })
    expect(
      await call('plain', 'ext.offerToAgent', { workspaceId: 'w1', label: 'L', text: 'go' }),
    ).toMatchObject({ ok: true })
    clock += 60_000
    expect(
      await call('tasker', 'ext.runAgent', { workspaceId: 'w1', agent: 'claude', prompt: 'go' }),
    ).toMatchObject({ ok: true })
  })

  it('remembers at most REACHED_PANES_MAX panes, dropping closed ones first to make room', async () => {
    focusPaneIn.mockReturnValue(true)
    const ids: string[] = []
    const runAndOpen = async (): Promise<string> => {
      const pane = registerPane({
        windowId: '7',
        workspaceId: 'w1',
        paneId: `pane-cap-${ids.length}`,
      })
      ids.push(pane.paneId)
      openTerminalIn.mockResolvedValueOnce(pane.externalId)
      clock += 60_001
      const res = await call('tasker', 'ext.runAgent', {
        workspaceId: 'w1',
        agent: 'claude',
        prompt: 'go',
      })
      expect(res).toEqual({ ok: true, paneId: pane.externalId })
      return pane.externalId
    }
    const reached = async (externalId: string): Promise<boolean> => {
      const res = await call('tasker', 'ext.focusPane', { paneId: externalId })
      return res.ok === true
    }
    const external: string[] = []
    for (let i = 0; i < REACHED_PANES_MAX; i++) external.push(await runAndOpen())

    const overflow = await runAndOpen()
    expect(await reached(overflow)).toBe(false)
    expect(await reached(external[0] as string)).toBe(true)

    removePane(ids[0] as string)
    const replacement = await runAndOpen()
    expect(await reached(replacement)).toBe(true)
    expect(await reached(external[1] as string)).toBe(true)
    expect(await reached(external[0] as string)).toBe(false)

    for (const id of ids.slice(1)) removePane(id)
  })

  it('focuses only a pane the extension opened or the human picked for it', async () => {
    focusPaneIn.mockReturnValue(true)
    expect(await call('tasker', 'ext.focusPane', { paneId: stranger.externalId })).toMatchObject({
      ok: false,
      error: 'not-reached',
    })
    expect(await call('plain', 'ext.focusPane', { paneId: opened.externalId })).toMatchObject({
      ok: false,
      error: 'not-reached',
    })
    expect(await call('tasker', 'ext.focusPane', { paneId: opened.externalId })).toEqual({
      ok: true,
    })
    expect(await call('plain', 'ext.focusPane', { paneId: picked.externalId })).toEqual({
      ok: true,
    })
    expect(focusPaneIn.mock.calls.map(([pane]) => pane.paneId)).toEqual([
      'pane-opened',
      'pane-picked',
    ])
    removePane('pane-picked')
    expect(await call('plain', 'ext.focusPane', { paneId: picked.externalId })).toMatchObject({
      ok: false,
      error: 'unknown-pane',
    })
  })
})
