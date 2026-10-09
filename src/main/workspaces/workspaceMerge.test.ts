import { ipcMain } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { SandboxMergeRefusal } from '../../shared/sandbox/sandbox'
import { checkMerge, registerWorkspaceMergeIpc } from './workspaceMerge'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

function deps(
  over: {
    owners?: Record<string, string>
    managers?: string[]
    sandbox?: SandboxMergeRefusal | null
  } = {},
) {
  const owners = over.owners ?? { a: '7', b: '7', c: '9' }
  return {
    ownerWindow: (id: string) => owners[id],
    hasManager: (id: string) => (over.managers ?? []).includes(id),
    sandboxRefusal: vi.fn(() => over.sandbox ?? null),
  }
}

describe('checkMerge', () => {
  it('allows two workspaces the sending window owns', () => {
    expect(checkMerge(deps(), '7', 'a', 'b')).toEqual({ ok: true })
  })

  it('refuses a workspace another window owns, an unknown one or a merge into itself', () => {
    expect(checkMerge(deps(), '7', 'a', 'c')).toEqual({ ok: false, error: 'not-owned' })
    expect(checkMerge(deps(), '9', 'a', 'b')).toEqual({ ok: false, error: 'not-owned' })
    expect(checkMerge(deps(), '7', 'a', 'zzz')).toEqual({ ok: false, error: 'not-owned' })
    expect(checkMerge(deps(), '7', 'a', 'a')).toEqual({ ok: false, error: 'not-owned' })
    expect(checkMerge(deps(), '7', 1, 'b')).toEqual({ ok: false, error: 'not-owned' })
  })

  it('refuses the manager workspace on either side', () => {
    expect(checkMerge(deps({ managers: ['a'] }), '7', 'a', 'b')).toEqual({
      ok: false,
      error: 'manager',
    })
    expect(checkMerge(deps({ managers: ['b'] }), '7', 'a', 'b')).toEqual({
      ok: false,
      error: 'manager',
    })
  })

  it('passes the sandbox refusal through', () => {
    const d = deps({ sandbox: 'sandbox-differs' })
    expect(checkMerge(d, '7', 'a', 'b')).toEqual({ ok: false, error: 'sandbox-differs' })
    expect(d.sandboxRefusal).toHaveBeenCalledWith('a', 'b')
  })

  it('merges in main over workspace:merge only when the check allows it', () => {
    const merge = vi.fn()
    registerWorkspaceMergeIpc({ ...deps(), merge })
    const call = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === 'workspace:merge')
    const handle = call?.[1] as (e: unknown, ...args: unknown[]) => unknown

    expect(handle({ sender: { id: 7 } }, 'a', 'c')).toEqual({ ok: false, error: 'not-owned' })
    expect(merge).not.toHaveBeenCalled()
    expect(handle({ sender: { id: 7 } }, 'a', 'b')).toEqual({ ok: true })
    expect(merge).toHaveBeenCalledWith('a', 'b')
  })
})
