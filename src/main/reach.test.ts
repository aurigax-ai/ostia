import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalOutcome } from '../shared/approvals'
import type { ReachMode } from '../shared/reach'
import { emptyWorkspaceSandbox } from '../shared/sandbox'
import type { ApprovalAsk } from './approvals'

const request = vi.fn(async (_ask: ApprovalAsk): Promise<ApprovalOutcome> => 'deny')

vi.mock('./approvals', () => ({ approvals: () => ({ request }) }))

const { grant, initCaps } = await import('./capabilityStore')
const { setCapFilter } = await import('./controlAuth')
const { registerPane } = await import('./idRegistry')
const { createReach } = await import('./reach')
type ReachGroupListing = import('./reach').ReachGroupListing

const home = realpathSync(mkdtempSync(join(tmpdir(), 'reach-runtime-')))
const repoA = join(home, 'a')
const repoB = join(home, 'b')
mkdirSync(join(repoA, '.git'), { recursive: true })
mkdirSync(join(repoB, '.git'), { recursive: true })

const workDirs: Record<string, string> = {
  coord: repoA,
  workers: repoA,
  elsewhere: repoB,
  scratch: repoA,
}

let mode: ReachMode = 'project'
let listing: ReachGroupListing = { workspaces: [], groups: [] }
const ask = vi.fn((a: ApprovalAsk) => request(a))

const reach = createReach({
  mode: () => mode,
  home,
  workDir: (id) => workDirs[id],
  isScratch: (id) => id === 'scratch',
  hasManager: () => false,
  sandbox: () => emptyWorkspaceSandbox(),
  groups: async () => listing,
  ask,
})

let seq = 0
function caller(workspaceId = 'coord') {
  const paneId = `reach-caller-${++seq}`
  const identity = registerPane({ windowId: 'w1', workspaceId, paneId })
  initCaps(identity.externalId)
  return {
    identity,
    authed: { externalId: identity.externalId, paneId, workspaceId },
  }
}

function grouped(entries: Record<string, string | undefined>): ReachGroupListing {
  return {
    workspaces: Object.entries(entries).map(([workspaceId, groupId]) => ({
      workspaceId,
      name: workspaceId,
      ...(groupId ? { groupId } : {}),
    })),
    groups: [{ groupId: 'g1', name: 'terminal' }],
  }
}

beforeEach(() => {
  mode = 'project'
  listing = { workspaces: [], groups: [] }
  request.mockReset()
  request.mockResolvedValue('deny')
  ask.mockClear()
  setCapFilter(() => true)
})

describe('createReach', () => {
  it('project: reaches a workspace of the same repository without asking', async () => {
    await expect(reach.ensure(caller(), 'workers', 'process.run', 'x')).resolves.toBeUndefined()
    expect(request).not.toHaveBeenCalled()
  })

  it('project: a different repository asks for all-workspaces exactly as before', async () => {
    await expect(reach.ensure(caller(), 'elsewhere', 'process.run', 'x')).rejects.toThrow(
      'denied: all-workspaces',
    )
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ caps: ['all-workspaces'] }))
  })

  it('project: a scratch workspace in the same folder is never in scope', async () => {
    expect(await reach.inScope(caller(), 'scratch')).toBe(false)
  })

  it('workspace: only the caller’s own workspace', async () => {
    mode = 'workspace'
    expect(await reach.inScope(caller(), 'coord')).toBe(true)
    expect(await reach.inScope(caller(), 'workers')).toBe(false)
  })

  it('a script with no workspace of its own has no scope', async () => {
    const script = caller('')
    expect(await reach.inScope(script, 'workers')).toBe(false)
  })

  it('visible: lists only workspaces in scope, every workspace with all-workspaces', async () => {
    const plain = caller()
    const sees = await reach.visible(plain)
    expect(['coord', 'workers', 'elsewhere'].filter(sees)).toEqual(['coord', 'workers'])
    grant(plain.identity.externalId, 'all-workspaces')
    expect((await reach.visible(plain))('elsewhere')).toBe(true)
  })

  it('group: a membership the human made is one scope', async () => {
    mode = 'group'
    listing = grouped({ coord: 'g1', elsewhere: 'g1' })
    expect(await reach.inScope(caller(), 'elsewhere')).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('group: a workspace an agent moved into the group asks the human to confirm it first', async () => {
    mode = 'group'
    listing = grouped({ coord: 'g1', elsewhere: undefined })
    await reach.byAgent(async () => {
      listing = grouped({ coord: 'g1', elsewhere: 'g1' })
    })

    expect(await reach.inScope(caller(), 'elsewhere')).toBe(false)
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'reach-group', subject: 'elsewhere', caps: [] }),
    )

    request.mockResolvedValue('workspace')
    expect(await reach.inScope(caller(), 'elsewhere')).toBe(true)
    ask.mockClear()
    expect(await reach.inScope(caller(), 'elsewhere')).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('group: a caller holding all-workspaces is never shown the confirm card', async () => {
    mode = 'group'
    listing = grouped({ coord: 'g1', workers: undefined })
    await reach.byAgent(async () => {
      listing = grouped({ coord: 'g1', workers: 'g1' })
    })
    const strong = caller()
    grant(strong.identity.externalId, 'all-workspaces')
    expect(await reach.inScope(strong, 'workers')).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it('group: an agent that put its own workspace in a group gains nothing from it', async () => {
    mode = 'group'
    listing = grouped({ coord: undefined, workers: 'g1' })
    await reach.byAgent(async () => {
      listing = grouped({ coord: 'g1', workers: 'g1' })
    })
    expect(await reach.inScope(caller(), 'workers')).toBe(false)
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ subject: 'coord' }))
  })

  it('group: a group listing that fails gives no group reach', async () => {
    mode = 'group'
    const failing = createReach({
      mode: () => 'group',
      home,
      workDir: (id) => workDirs[id],
      isScratch: () => false,
      hasManager: () => false,
      sandbox: () => emptyWorkspaceSandbox(),
      groups: async () => {
        throw new Error('window gone')
      },
      ask,
    })
    expect(await failing.inScope(caller(), 'workers')).toBe(false)
  })
})
