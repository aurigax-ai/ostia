import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorCodes, type MessageConnection, ResponseError } from 'vscode-jsonrpc/node'
import type { AuthedConn } from '../control/controlAuth'
import { type PaneIdentity, registerPane } from '../control/idRegistry'

const ensureCaps = vi.fn()
vi.mock('../approvals/controlElevation', () => ({ ensureCaps }))

const { ExtensionRuns } = await import('./extensionRuns')

const pane = registerPane({ windowId: '7', workspaceId: 'w1', paneId: 'pane-callercaps' })
const authed: AuthedConn = {
  externalId: pane.externalId,
  paneId: 'pane-callercaps',
  workspaceId: 'w1',
}
const conn = {} as MessageConnection
const extension = registerPane({ windowId: '7', workspaceId: 'w1', paneId: 'pane-ext' })

function runs(options: { builtin?: boolean; serving?: { cli: number; user: number } | null } = {}) {
  const serving = new Map<string, { cli: number; user: number }>()
  if (options.serving !== null) serving.set(pane.externalId, options.serving ?? { cli: 1, user: 0 })
  const rt = { ext: { builtin: options.builtin ?? true, manifest: { id: 'handoff' } }, serving }
  return new ExtensionRuns({
    deps: {},
    runtimeOf: () => rt,
    shownName: () => 'Handoff',
    runtimes: new Map(),
    active: () => true,
    granted: () => [],
  } as never)
}

const ask = (r: InstanceType<typeof ExtensionRuns>, params: unknown = {}) =>
  r.requireCallerCaps(extension as PaneIdentity, conn, {
    paneId: pane.externalId,
    caps: ['all-workspaces'],
    reason: 'read every project',
    ...(params as object),
  })

describe('ext.requireCallerCaps', () => {
  beforeEach(() => {
    ensureCaps.mockReset().mockResolvedValue(undefined)
  })

  it('asks the card for the pane whose command line call is held and answers ok when allowed', async () => {
    const r = runs()
    const release = r.holdCliCall(pane, authed)
    expect(await ask(r)).toEqual({ ok: true })
    expect(ensureCaps).toHaveBeenCalledWith(
      authed,
      pane,
      ['all-workspaces'],
      'Handoff: read every project',
      '',
    )
    release()
  })

  it('passes the human’s denial and silence on with the usual hint', async () => {
    const r = runs()
    r.holdCliCall(pane, authed)
    ensureCaps.mockRejectedValueOnce(
      new ResponseError(ErrorCodes.InvalidRequest, 'denied: all-workspaces', {
        hint: 'Do not retry.',
      }),
    )
    expect(await ask(r)).toMatchObject({ ok: false, error: 'denied' })
    ensureCaps.mockRejectedValueOnce(
      new ResponseError(ErrorCodes.InvalidRequest, 'not-approved: all-workspaces'),
    )
    expect(await ask(r)).toMatchObject({ ok: false, error: 'not-approved' })
  })

  it('reports a sandboxed pane as refused, as ensureCaps does before any card', async () => {
    const r = runs()
    r.holdCliCall(pane, authed)
    ensureCaps.mockRejectedValueOnce(
      new ResponseError(ErrorCodes.InvalidRequest, 'sandboxed: all-workspaces'),
    )
    expect(await ask(r)).toMatchObject({ ok: false, error: 'sandboxed' })
  })

  it('refuses an extension that is not built in, before any card', async () => {
    const r = runs({ builtin: false })
    r.holdCliCall(pane, authed)
    expect(await ask(r)).toMatchObject({ ok: false, error: 'not-available' })
    expect(ensureCaps).not.toHaveBeenCalled()
  })

  it('refuses a pane that is not on a held command line call', async () => {
    const r = runs()
    expect(await ask(r)).toMatchObject({ ok: false, error: 'not-reached' })
    const palette = runs({ serving: { cli: 0, user: 1 } })
    palette.holdCliCall(pane, authed)
    expect(await ask(palette)).toMatchObject({ ok: false, error: 'not-reached' })
    expect(await ask(runs({ serving: null }))).toMatchObject({ ok: false, error: 'not-reached' })
    expect(ensureCaps).not.toHaveBeenCalled()
  })

  it('forgets a call once it is released, so a later call cannot raise a card for the pane', async () => {
    const r = runs()
    const release = r.holdCliCall(pane, authed)
    release()
    release()
    expect(await ask(r)).toMatchObject({ ok: false, error: 'not-reached' })
    expect(ensureCaps).not.toHaveBeenCalled()
  })

  it('takes only all-workspaces and a clean one-line reason', async () => {
    const r = runs()
    r.holdCliCall(pane, authed)
    for (const bad of [{ caps: ['kill-pane'] }, { caps: [] }, { reason: '' }, { reason: 'a\u0000b' }]) {
      expect(await ask(r, bad)).toMatchObject({ ok: false, error: 'invalid-params' })
    }
    expect(ensureCaps).not.toHaveBeenCalled()
  })
})
