import { describe, expect, it } from 'vitest'
import { attachWorkspace } from './attachWorkspace'

describe('attachWorkspace', () => {
  it('SBX-C13 refuses an attach that names another workspace than the pane is registered in', () => {
    expect(attachWorkspace('ws-a', 'ws-b')).toEqual({ ok: false })
  })

  it('SBX-C14 takes the workspace from the attach when pane-created has not arrived yet', () => {
    expect(attachWorkspace(undefined, 'ws-a')).toEqual({ ok: true, workspaceId: 'ws-a' })
    expect(attachWorkspace('', 'ws-a')).toEqual({ ok: true, workspaceId: 'ws-a' })
    expect(attachWorkspace('ws-a', 'ws-a')).toEqual({ ok: true, workspaceId: 'ws-a' })
    expect(attachWorkspace('ws-a', '')).toEqual({ ok: true, workspaceId: 'ws-a' })
  })
})
