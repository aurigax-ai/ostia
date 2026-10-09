import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionCaller } from '../../shared/extensions'
import type { CommandResult } from '../../shared/types'
import { registerControlServer, stopControlServer } from '../control/controlServer'
import {
  type ExtensionConfirmRequest,
  ExtensionHost,
  registerExtensionMethods,
} from './extensionHost'
import { ExtensionStore } from './extensionStore'

const fixtures = resolve(__dirname, '../../../test/fixtures/extensions-api')

const caller: ExtensionCaller = {
  kind: 'user',
  workspaceId: 's1',
  capabilities: [],
}

describe('ExtensionHost confirm and panel notifications', () => {
  let dir: string
  let host: ExtensionHost
  let store: ExtensionStore
  const confirm = vi.fn<(req: ExtensionConfirmRequest) => Promise<boolean>>()
  const notify = vi.fn()
  const notifyPanel = vi.fn()
  const openPanelIn = vi.fn()

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-ext-api-'))
    const socketPath = join(dir, 'control.sock')
    store = new ExtensionStore(join(dir, 'extensions.json'))
    host = new ExtensionHost({
      roots: [{ dir: fixtures, builtin: true }],
      store,
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: () => undefined,
      broadcast: () => {},
      openPanelIn,
      notify,
      confirm,
      notifyPanel,
      restartDelayMs: 20,
      readyTimeoutMs: 8000,
      requestTimeoutMs: 4000,
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
    host.stopAll()
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    confirm.mockReset()
    notify.mockReset()
    notifyPanel.mockReset()
    openPanelIn.mockReset()
  })

  it('asks the human through the confirm sink and returns the answer', async () => {
    confirm.mockResolvedValue(true)
    const res = await host.invoke(
      'asker',
      'confirm',
      { title: 'Init', message: 'Run it?', confirmLabel: 'Run', cancelLabel: 'No' },
      caller,
    )
    expect(res).toEqual({ ok: true, data: { ok: true, confirmed: true } })
    expect(confirm).toHaveBeenCalledWith({
      extId: 'asker',
      extName: 'Asker',
      title: 'Init',
      message: 'Run it?',
      confirmLabel: 'Run',
      cancelLabel: 'No',
    })
  })

  it('passes a refusal back as not confirmed', async () => {
    confirm.mockResolvedValue(false)
    const res = await host.invoke('asker', 'confirm', { title: 'T', message: 'M' }, caller)
    expect(res).toEqual({ ok: true, data: { ok: true, confirmed: false } })
  })

  it('refuses a confirm without a message and never shows a dialog', async () => {
    const res = await host.invoke('asker', 'confirm', { title: 'T' }, caller)
    expect(res).toMatchObject({ ok: true, data: { ok: false, error: 'invalid-params' } })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('posts an openPanel notification whose click opens that extension panel', async () => {
    const res = await host.invoke('asker', 'notify-panel', null, caller)
    expect(res.ok).toBe(true)
    expect(notify).not.toHaveBeenCalled()
    expect(notifyPanel).toHaveBeenCalledTimes(1)
    const [n, open] = notifyPanel.mock.calls[0]
    expect(n).toEqual({ title: 'look', body: 'here', from: 'extension:asker', extId: 'asker' })
    open()
    expect(openPanelIn).toHaveBeenCalledWith({ extId: 'asker' })
  })

  it('stops a running extension when a reloaded store disables it', async () => {
    await host.invoke('asker', 'notify-panel', null, caller)
    expect(host.list()[0].status).toBe('running')
    store.set('asker', { enabled: false, approved: ['notify'] })
    host.reloadRecords()
    const start = Date.now()
    while (host.list()[0].status !== 'disabled' && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(host.list()[0].status).toBe('disabled')
    expect(await host.invoke('asker', 'confirm', {}, caller)).toMatchObject({
      ok: false,
      error: 'extension-disabled',
    })
  })
})
