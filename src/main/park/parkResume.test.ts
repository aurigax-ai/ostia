import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentResume } from '../../shared/agents/agentResume'
import { ParkedStore } from './parkedStore'
import { forgetParked, type ParkResumeDeps, parkedItemOf, resumeParked } from './parkResume'

const resume: AgentResume = {
  agent: 'claude',
  id: 's1',
  cwd: '/home/u/api',
  args: ['--model', 'opus'],
}

function setup(over: Partial<ParkResumeDeps> = {}) {
  const store = new ParkedStore(join(mkdtempSync(join(tmpdir(), 'resume-')), 'p.json'), () => 7)
  const parked = store.park({
    workspaceId: 'w1',
    resume,
    title: 'export-tests',
    summary: 'where it stopped',
    note: 'after lunch',
  })
  if (!parked.ok) throw new Error('not parked')
  const openTab = vi.fn(async () => true)
  const deps: ParkResumeDeps = {
    store,
    workspaceOpen: async () => true,
    isDirectory: async () => true,
    holderOf: async () => null,
    openTab,
    ...over,
  }
  return { deps, store, id: parked.record.id, openTab }
}

describe('resumeParked', () => {
  it('opens a tab for the record and leaves the record for the start hook to settle', async () => {
    const { deps, store, id, openTab } = setup()
    expect(await resumeParked(deps, id)).toEqual({ ok: true })
    expect(openTab).toHaveBeenCalledWith('w1', expect.objectContaining({ id }))
    expect(store.get(id)).toBeDefined()
  })

  it('answers an unknown id', async () => {
    const { deps } = setup()
    expect(await resumeParked(deps, 'zzzzzzzzzz')).toEqual({ ok: false, error: 'unknown-parked' })
  })

  it('opens nothing when the workspace is closed', async () => {
    const { deps, id, openTab } = setup({ workspaceOpen: async () => false })
    expect(await resumeParked(deps, id)).toEqual({ ok: false, error: 'workspace-closed' })
    expect(openTab).not.toHaveBeenCalled()
  })

  it('opens nothing when the folder is gone and names it', async () => {
    const { deps, id, openTab } = setup({ isDirectory: async () => false })
    expect(await resumeParked(deps, id)).toEqual({
      ok: false,
      error: 'folder-gone',
      message: '/home/u/api',
    })
    expect(openTab).not.toHaveBeenCalled()
  })

  it('opens nothing when the session runs in another tab and names the tab', async () => {
    const holderOf = vi.fn(async () => 'docs')
    const { deps, id, openTab } = setup({ holderOf })
    expect(await resumeParked(deps, id)).toEqual({
      ok: false,
      error: 'running-elsewhere',
      message: 'docs',
    })
    expect(holderOf).toHaveBeenCalledWith(resume)
    expect(openTab).not.toHaveBeenCalled()
  })

  it('reports unavailable when the window could not open the tab', async () => {
    const { deps, id } = setup({ openTab: async () => false })
    expect(await resumeParked(deps, id)).toEqual({ ok: false, error: 'unavailable' })
  })
})

describe('forgetParked', () => {
  it('removes a record once', () => {
    const { store, id } = setup()
    expect(forgetParked(store, id)).toEqual({ ok: true })
    expect(forgetParked(store, id)).toEqual({ ok: false, error: 'unknown-parked' })
  })
})

describe('parkedItemOf', () => {
  it('hands the extension display fields only, never flags or a command', () => {
    const { store, id } = setup()
    const item = parkedItemOf(store.get(id) as never)
    expect(item).toEqual({
      id,
      workspaceId: 'w1',
      agent: 'claude',
      sessionId: 's1',
      title: 'export-tests',
      summary: 'where it stopped',
      note: 'after lunch',
      folder: '/home/u/api',
      parkedAt: 7,
    })
    expect(JSON.stringify(item)).not.toContain('opus')
  })
})
