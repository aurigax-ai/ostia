import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalState } from '../../shared/permissions/approvals'

const userData = mkdtempSync(join(tmpdir(), 'ostia-approvals-int-'))
const settingsFile = join(userData, 'settings.json')
const handlers = new Map<string, (...args: unknown[]) => unknown>()
const sent: ApprovalState[] = []

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
  webContents: {
    fromId: () => ({
      isDestroyed: () => false,
      send: (_channel: string, state: ApprovalState) => sent.push(state),
    }),
  },
}))

const { registerApprovals, approvals } = await import('./approvals')
const { ensureCaps } = await import('./controlElevation')
const { initCaps } = await import('./capabilityStore')
const { registerPane } = await import('../control/idRegistry')

const identity = registerPane({ windowId: '7', workspaceId: 'ws-int', paneId: 'pane-int' })
const conn = { externalId: identity.externalId, paneId: 'pane-int', workspaceId: 'ws-int' }
const sender = { id: 7, getType: () => 'window' }

function ask(): Promise<void> {
  return ensureCaps(conn, identity, ['settings-write'], 'settings.set', 'sidebar.showSSH')
}

function pendingId(): string {
  const queue = approvals()
  if (!queue) throw new Error('approvals not registered')
  const [first] = queue.stateFor('7').pending
  if (!first) throw new Error('nothing is waiting for the human')
  return first.id
}

function answer(choice: string): boolean {
  return handlers.get('approvals:answer')?.({ sender }, pendingId(), choice) as boolean
}

function history(): string[] {
  return (approvals()?.stateFor('7').history ?? []).map((r) => r.outcome).reverse()
}

beforeAll(() => {
  registerApprovals(
    () => {},
    () => {},
    { opened: () => {}, settled: () => {} },
  )
})

beforeEach(() => {
  writeFileSync(settingsFile, JSON.stringify({}))
  handlers.get('approvals:remove-always')?.({ sender }, 'settings-write')
  initCaps(conn.externalId)
})

describe('approvals end to end', () => {
  it('an agent call that lacks a capability waits for the human and continues once allowed', async () => {
    let settled = false
    const first = ask().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(approvals()?.stateFor('7').pending).toMatchObject([
      { caps: ['settings-write'], action: 'settings.set' },
    ])

    expect(answer('once')).toBe(true)
    await first
    expect(settled).toBe(true)

    const second = ask()
    const refused = second.catch((e: Error) => e)
    expect(approvals()?.stateFor('7').pending).toHaveLength(1)
    expect(answer('deny')).toBe(true)
    const error = await refused
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('denied: settings-write')

    expect(history()).toEqual(['once', 'deny'])
    expect(sent.at(-1)?.pending).toEqual([])
  })

  it('always allow saves the grant, stops asking, and Remove in Settings asks again', async () => {
    const first = ask()
    expect(answer('always')).toBe(true)
    await first

    const saved = JSON.parse(readFileSync(settingsFile, 'utf8'))
    expect(saved.capabilities.grants).toEqual(['settings-write'])

    const again = ask()
    expect(approvals()?.stateFor('7').pending).toEqual([])
    await again

    expect(handlers.get('approvals:remove-always')?.({ sender }, 'settings-write')).toBe(true)
    expect(JSON.parse(readFileSync(settingsFile, 'utf8')).capabilities.grants).toEqual([])

    const third = ask()
    const refused = third.catch((e: Error) => e)
    expect(approvals()?.stateFor('7').pending).toHaveLength(1)
    expect(answer('deny')).toBe(true)
    expect(((await refused) as Error).message).toBe('denied: settings-write')
  })
})
