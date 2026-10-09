import { type WorkspaceSandbox, emptyWorkspaceSandbox } from '@shared/sandbox/sandbox'
import { describe, expect, it } from 'vitest'
import {
  type MergeSide,
  inferHome,
  mergeOptions,
  mergeRefusal,
  workspacePath,
} from './mergeEligibility'

const HOME = '/home/u'

function side(id: string, over: Partial<MergeSide> = {}): MergeSide {
  return {
    id,
    kind: 'terminal',
    workDir: '/home/u/proj',
    windowId: 'win1',
    sandbox: null,
    ...over,
  }
}

function sandbox(over: Partial<WorkspaceSandbox> = {}): WorkspaceSandbox {
  return { ...emptyWorkspaceSandbox(), enabled: true, ...over }
}

describe('workspacePath', () => {
  it('prefers the project folder over the work folder', () => {
    expect(workspacePath({ workDir: '/home/u/proj/src', projectDir: '~/proj' }, HOME)).toBe(
      '/home/u/proj',
    )
  })

  it('drops trailing slashes and resolves dot segments', () => {
    expect(workspacePath({ workDir: '/home/u/proj/' }, HOME)).toBe('/home/u/proj')
    expect(workspacePath({ workDir: '/home/u/x/../proj/.' }, HOME)).toBe('/home/u/proj')
  })

  it('expands ~ when the home folder is known and keeps it otherwise', () => {
    expect(workspacePath({ workDir: '~/proj' }, HOME)).toBe('/home/u/proj')
    expect(workspacePath({ workDir: '~' }, HOME)).toBe('/home/u')
    expect(workspacePath({ workDir: '~/proj/' }, null)).toBe('~/proj')
  })
})

describe('inferHome', () => {
  it('reads the home folder off a workspace whose project is shown under ~', () => {
    expect(inferHome([{ workDir: '/home/u/proj', projectDir: '~/proj' }])).toBe('/home/u')
    expect(inferHome([{ workDir: '/home/u', projectDir: '~' }])).toBe('/home/u')
  })

  it('returns null when no workspace shows a project under ~', () => {
    expect(inferHome([{ workDir: '/srv/app' }, { workDir: '/srv/x', projectDir: '/srv/x' }])).toBe(
      null,
    )
  })
})

describe('mergeRefusal', () => {
  it('allows two workspaces of one window in the same folder', () => {
    expect(mergeRefusal(side('a'), side('b'), HOME)).toBeNull()
  })

  it('matches a ~ project against the same absolute folder', () => {
    const source = side('a', { workDir: '~/proj' })
    const target = side('b', { workDir: '/home/u/proj/', projectDir: '~/proj' })
    expect(mergeRefusal(source, target, HOME)).toBeNull()
  })

  it('refuses a workspace in another folder', () => {
    expect(mergeRefusal(side('a'), side('b', { workDir: '/home/u/other' }), HOME)).toBe(
      'other-path',
    )
  })

  it('refuses merging a workspace into itself', () => {
    expect(mergeRefusal(side('a'), side('a'), HOME)).toBe('self')
  })

  it('never merges the manager workspace either way', () => {
    expect(mergeRefusal(side('a', { kind: 'manager' }), side('b'), HOME)).toBe('manager')
    expect(mergeRefusal(side('a'), side('b', { kind: 'manager' }), HOME)).toBe('manager')
  })

  it('refuses a workspace in another window', () => {
    expect(mergeRefusal(side('a'), side('b', { windowId: 'win2' }), HOME)).toBe('other-window')
  })

  it('refuses a sandboxed and a plain workspace', () => {
    expect(mergeRefusal(side('a', { sandbox: sandbox() }), side('b'), HOME)).toBe('sandbox-mixed')
    expect(mergeRefusal(side('a'), side('b', { sandbox: sandbox() }), HOME)).toBe('sandbox-mixed')
  })

  it('merges two sandboxes only when their settings are the same', () => {
    const one = sandbox({ domains: ['a.dev', 'b.dev'], controls: { browser: 'allowlist' } })
    const same = sandbox({ domains: ['b.dev', 'a.dev'], controls: { browser: 'allowlist' } })
    const other = sandbox({ domains: ['a.dev'], controls: { browser: 'allowlist' } })
    expect(mergeRefusal(side('a', { sandbox: one }), side('b', { sandbox: same }), HOME)).toBeNull()
    expect(mergeRefusal(side('a', { sandbox: one }), side('b', { sandbox: other }), HOME)).toBe(
      'sandbox-differs',
    )
  })

  it('treats a disabled sandbox with leftover settings like no sandbox', () => {
    const off = { ...emptyWorkspaceSandbox(), domains: ['a.dev'] }
    expect(mergeRefusal(side('a', { sandbox: off }), side('b'), HOME)).toBeNull()
  })
})

describe('mergeOptions', () => {
  it('lists same-folder workspaces with the reason a refused one cannot merge', () => {
    const source = side('a')
    const options = mergeOptions(
      source,
      [
        source,
        side('b'),
        side('c', { workDir: '/home/u/elsewhere' }),
        side('d', { kind: 'manager' }),
        side('e', { windowId: 'win2' }),
        side('g', { windowId: 'win2', workDir: '/home/u/elsewhere' }),
        side('f', { sandbox: sandbox() }),
      ],
      HOME,
    )
    expect(options).toEqual([
      { targetId: 'b', refusal: null },
      { targetId: 'e', refusal: 'other-window' },
      { targetId: 'f', refusal: 'sandbox-mixed' },
    ])
  })
})
