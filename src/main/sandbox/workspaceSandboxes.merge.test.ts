import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SANDBOX_GLOBALS, emptyWorkspaceSandbox } from '../../shared/sandbox'
import { SandboxStore } from './store'
import { WorkspaceSandboxes } from './workspaceSandboxes'

let root: string

function setup(): { store: SandboxStore; sandboxes: WorkspaceSandboxes } {
  const store = new SandboxStore(join(root, 'sandbox.json'))
  const workDirs: Record<string, string> = { src: '/home/u/proj', dst: '/home/u/proj' }
  const sandboxes = new WorkspaceSandboxes({
    store,
    globals: () => DEFAULT_SANDBOX_GLOBALS,
    basePaths: () => ({ home: '/home/u', dataDirs: [], socketPath: '/tmp/s', runtimeReads: [] }),
    workDir: (id) => workDirs[id],
    tmpRoot: join(root, 'tmp'),
    nodePath: process.execPath,
    hostScript: join(root, 'missing.mjs'),
    onAsk: async () => false,
  })
  return { store, sandboxes }
}

const on = (domains: string[] = []) => ({ ...emptyWorkspaceSandbox(), enabled: true, domains })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ostia-sbx-merge-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('WorkspaceSandboxes merge', () => {
  it('refuses mixing a sandboxed and a plain workspace', () => {
    const { store, sandboxes } = setup()
    store.set('src', on())
    expect(sandboxes.mergeRefusal('src', 'dst')).toBe('sandbox-mixed')
    expect(sandboxes.mergeRefusal('dst', 'src')).toBe('sandbox-mixed')
  })

  it('refuses two sandboxes whose settings differ and allows equal ones', () => {
    const { store, sandboxes } = setup()
    store.set('src', on(['a.dev', 'b.dev']))
    store.set('dst', on(['a.dev']))
    expect(sandboxes.mergeRefusal('src', 'dst')).toBe('sandbox-differs')
    store.set('dst', on(['b.dev', 'a.dev']))
    expect(sandboxes.mergeRefusal('src', 'dst')).toBeNull()
  })

  it('makes the source follow the target’s policy and drops the source’s own entry', () => {
    const { store, sandboxes } = setup()
    store.set('src', on(['a.dev']))
    store.set('dst', on(['a.dev']))
    sandboxes.allowUntilRestart('src', 'once.dev')

    sandboxes.merge('src', 'dst')

    expect(store.has('src')).toBe(false)
    expect(sandboxes.owner('src')).toBe('dst')
    expect(sandboxes.isEnabled('src')).toBe(true)
    expect(sandboxes.resolved('src').domains).not.toContain('once.dev')
    sandboxes.allowUntilRestart('src', 'later.dev')
    expect(sandboxes.resolved('dst').domains).toContain('later.dev')
    sandboxes.update('src', (current) => ({ ...current, domains: [...current.domains, 'x.dev'] }))
    expect(store.get('dst').domains).toContain('x.dev')
  })

  it('keeps the source’s temp folder for its running processes until it is forgotten', () => {
    const { store, sandboxes } = setup()
    store.set('src', on())
    store.set('dst', on())
    const tmp = sandboxes.tmpDir('src')
    mkdirSync(tmp, { recursive: true })

    sandboxes.merge('src', 'dst')
    expect(existsSync(tmp)).toBe(true)
    expect(sandboxes.config('src').filesystem.allowWrite).toContain(tmp)

    sandboxes.forget('src')
    expect(existsSync(tmp)).toBe(false)
    expect(sandboxes.owner('src')).toBe('src')
  })

  it('offers the hidden-home notice once per sandbox, shared by merged workspaces, and again after it is forgotten', () => {
    const { store, sandboxes } = setup()
    store.set('src', on())
    store.set('dst', on())
    expect(sandboxes.claimHomeNotice('dst')).toBe(true)
    expect(sandboxes.claimHomeNotice('dst')).toBe(false)
    expect(sandboxes.claimHomeNotice('src')).toBe(true)
    sandboxes.merge('src', 'dst')
    expect(sandboxes.claimHomeNotice('src')).toBe(false)
    sandboxes.forget('dst')
    expect(sandboxes.claimHomeNotice('dst')).toBe(true)
  })
})
