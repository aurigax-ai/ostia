import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalMode, ApprovalState } from '../../shared/approvals'
import type { Capability } from '../../shared/capabilities'

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent' },
  ipcMain: { handle: vi.fn() },
  webContents: { fromId: vi.fn() },
}))

const { createApprovals } = await import('./approvals')

const ASK = {
  externalId: 'ext-1',
  windowId: '7',
  paneId: 'p1',
  workspaceId: 'w1',
  caps: ['shell'] as Capability[],
  action: 'command.exec agent.resume',
  detail: '{}',
}

function setup(mode: ApprovalMode = 'ask', windowOpen = true) {
  const published: ApprovalState[] = []
  const grant = vi.fn()
  const revoke = vi.fn()
  const reveal = vi.fn()
  const always = vi.fn((_caps: readonly Capability[]) => true)
  let currentMode = mode
  const approvals = createApprovals({
    mode: () => currentMode,
    publish: (_windowId, state) => {
      published.push(state)
      return windowOpen
    },
    grant,
    revoke,
    always,
    now: () => 1000,
    timeoutMs: 5000,
    reveal,
  })
  return {
    approvals,
    published,
    grant,
    revoke,
    reveal,
    always,
    setMode: (m: ApprovalMode) => {
      currentMode = m
    },
  }
}

describe('approvals', () => {
  it('MGR-C32 brings the pane window forward only when a request waits for the human', async () => {
    const { approvals, reveal, setMode } = setup()
    const waiting = approvals.request(ASK)
    expect(reveal).toHaveBeenCalledWith(ASK.windowId)
    approvals.answer(ASK.windowId, 'approval-1', 'once')
    await waiting
    reveal.mockClear()
    setMode('allow')
    await approvals.request({ ...ASK, caps: ['browse'] })
    expect(reveal).not.toHaveBeenCalled()
  })

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds the request and shows it to the pane window until the human answers once', async () => {
    const { approvals, published, grant } = setup()
    const outcome = approvals.request(ASK)

    expect(published.at(-1)?.pending).toMatchObject([{ paneId: 'p1', caps: ['shell'] }])
    const id = approvals.stateFor('7').pending[0].id
    expect(approvals.answer('7', id, 'once')).toBe(true)

    await expect(outcome).resolves.toBe('once')
    expect(grant).not.toHaveBeenCalled()
    expect(approvals.stateFor('7')).toMatchObject({
      pending: [],
      history: [{ id, outcome: 'once', revocable: false }],
    })
  })

  it('grants the caps to the pane for the session and can revoke them', async () => {
    const { approvals, grant, revoke } = setup()
    const outcome = approvals.request({ ...ASK, caps: ['shell', 'all-workspaces'] })
    const id = approvals.stateFor('7').pending[0].id
    approvals.answer('7', id, 'session')

    await expect(outcome).resolves.toBe('session')
    expect(grant.mock.calls).toEqual([
      ['ext-1', 'shell'],
      ['ext-1', 'all-workspaces'],
    ])
    expect(approvals.revoke('7', id)).toBe(true)
    expect(revoke.mock.calls).toEqual([
      ['ext-1', 'shell'],
      ['ext-1', 'all-workspaces'],
    ])
    expect(approvals.revoke('7', id)).toBe(false)
  })

  it('always allow saves the caps as a standing grant and lets the request through', async () => {
    const { approvals, always, grant } = setup()
    const outcome = approvals.request({ ...ASK, caps: ['send-other-pane'] })
    const id = approvals.stateFor('7').pending[0].id

    expect(approvals.answer('7', id, 'always')).toBe(true)

    await expect(outcome).resolves.toBe('always')
    expect(always).toHaveBeenCalledWith(['send-other-pane'])
    expect(grant).toHaveBeenCalledWith('ext-1', 'send-other-pane')
    expect(approvals.stateFor('7').history[0]).toMatchObject({
      outcome: 'always',
      revocable: false,
    })
  })

  it('keeps the card when the standing grant cannot be saved', async () => {
    const { approvals, always } = setup()
    always.mockReturnValue(false)
    void approvals.request(ASK)
    const id = approvals.stateFor('7').pending[0].id

    expect(approvals.answer('7', id, 'always')).toBe(false)
    expect(approvals.stateFor('7').pending.map((p) => p.id)).toEqual([id])
  })

  it.each([
    ['destructive', { caps: ['destructive'] as Capability[] }],
    ['credentials', { caps: ['browse', 'credentials'] as Capability[] }],
    ['a sandbox domain', { caps: [] as Capability[], kind: 'sandbox-domain' as const }],
    ['a secret', { caps: [] as Capability[], kind: 'secret' as const }],
    ['a package', { caps: [] as Capability[], kind: 'package' as const }],
  ])('refuses always allow for %s even when the renderer sends it', (_name, ask) => {
    const { approvals, always } = setup()
    void approvals.request({ ...ASK, ...ask })
    const id = approvals.stateFor('7').pending[0].id

    expect(approvals.answer('7', id, 'always')).toBe(false)
    expect(always).not.toHaveBeenCalled()
    expect(approvals.stateFor('7').pending.map((p) => p.id)).toEqual([id])
  })

  it('ignores answers from another window and unknown answers', async () => {
    const { approvals } = setup()
    const outcome = approvals.request(ASK)
    const id = approvals.stateFor('7').pending[0].id

    expect(approvals.answer('8', id, 'once')).toBe(false)
    expect(approvals.answer('7', id, 'forever')).toBe(false)
    expect(approvals.stateFor('8').pending).toEqual([])
    approvals.answer('7', id, 'deny')
    await expect(outcome).resolves.toBe('deny')
  })

  it('times out to a refusal when nobody answers', async () => {
    const { approvals } = setup()
    const outcome = approvals.request(ASK)
    vi.advanceTimersByTime(5000)
    await expect(outcome).resolves.toBe('timeout')
    expect(approvals.stateFor('7').history[0].outcome).toBe('timeout')
  })

  it('refuses at once when the pane window is gone', async () => {
    const { approvals } = setup('ask', false)
    await expect(approvals.request(ASK)).resolves.toBe('deny')
  })

  it('lets requests through in allow mode but still records them, except destructive', async () => {
    const { approvals } = setup('allow')
    await expect(approvals.request(ASK)).resolves.toBe('auto')
    expect(approvals.stateFor('7').history[0]).toMatchObject({ outcome: 'auto' })

    const destructive = approvals.request({ ...ASK, caps: ['destructive'] })
    expect(approvals.stateFor('7').pending).toHaveLength(1)
    const id = approvals.stateFor('7').pending[0].id
    expect(approvals.answer('7', id, 'session')).toBe(false)
    approvals.answer('7', id, 'deny')
    await expect(destructive).resolves.toBe('deny')
  })

  it('refuses pending requests and ends session grants when the pane goes away', async () => {
    const { approvals } = setup()
    const first = approvals.request(ASK)
    const firstId = approvals.stateFor('7').pending[0].id
    approvals.answer('7', firstId, 'session')
    await first
    const second = approvals.request(ASK)

    approvals.forget('ext-1')

    await expect(second).resolves.toBe('deny')
    expect(approvals.stateFor('7').history.find((r) => r.id === firstId)?.revocable).toBe(false)
  })

  it('moves pending cards and history to the window a pane moved to', async () => {
    const published: { windowId: string; state: ApprovalState }[] = []
    const approvals = createApprovals({
      mode: () => 'ask',
      publish: (windowId, state) => {
        published.push({ windowId, state })
        return true
      },
      grant: vi.fn(),
      revoke: vi.fn(),
      always: vi.fn(() => true),
      reveal: vi.fn(),
      now: () => 1000,
      timeoutMs: 5000,
    })
    const outcome = approvals.request(ASK)
    const id = approvals.stateFor('7').pending[0].id

    approvals.rehome(['ext-1'], '9')

    expect(approvals.stateFor('7').pending).toEqual([])
    expect(approvals.stateFor('9').pending.map((p) => p.id)).toEqual([id])
    expect(
      published
        .slice(-2)
        .map((p) => p.windowId)
        .sort(),
    ).toEqual(['7', '9'])
    expect(approvals.answer('7', id, 'once')).toBe(false)
    expect(approvals.answer('9', id, 'once')).toBe(true)
    await expect(outcome).resolves.toBe('once')
  })

  describe('sandbox requests', () => {
    const DOMAIN_ASK = {
      ...ASK,
      caps: [] as Capability[],
      kind: 'sandbox-domain' as const,
      subject: 'example.com',
      action: 'reach example.com',
    }

    it('SBX-C18 still shows a card for a sandbox request when approvals.mode is allow', async () => {
      const { approvals, published } = setup('allow')
      const outcome = approvals.request(DOMAIN_ASK)
      expect(published.at(-1)?.pending).toHaveLength(1)
      expect(published.at(-1)?.pending[0]).toMatchObject({
        kind: 'sandbox-domain',
        subject: 'example.com',
      })
      expect(approvals.answer('7', published.at(-1)?.pending[0].id ?? '', 'workspace')).toBe(true)
      await expect(outcome).resolves.toBe('workspace')
    })

    it('SBX-C19 denies a sandbox request whose card times out', async () => {
      const { approvals, grant } = setup()
      const outcome = approvals.request(DOMAIN_ASK)
      vi.advanceTimersByTime(5000)
      await expect(outcome).resolves.toBe('timeout')
      expect(grant).not.toHaveBeenCalled()
    })

    it('SBX-C20 never turns a lasting sandbox answer into a capability grant', async () => {
      const { approvals, published, grant } = setup()
      const outcome = approvals.request(DOMAIN_ASK)
      const id = published.at(-1)?.pending[0].id ?? ''
      expect(approvals.answer('7', id, 'once')).toBe(false)
      expect(approvals.answer('7', id, 'workspace')).toBe(true)
      await expect(outcome).resolves.toBe('workspace')
      expect(grant).not.toHaveBeenCalled()
      expect(published.at(-1)?.history[0]).toMatchObject({
        outcome: 'workspace',
        revocable: false,
      })
      const capOutcome = approvals.request(ASK)
      const capId = published.at(-1)?.pending[0].id ?? ''
      expect(approvals.answer('7', capId, 'workspace')).toBe(false)
      approvals.answer('7', capId, 'deny')
      await capOutcome
    })
  })
})
