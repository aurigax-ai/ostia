import { vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ArtifactProducers } from './artifactProducers'

let root: string
let folder: string

function producers(): ArtifactProducers {
  return new ArtifactProducers({
    file: (workspaceId) => join(root, '.history', workspaceId, 'producers.json'),
    folderOf: (workspaceId) => (workspaceId === 'w1' ? folder : null),
  })
}

function write(name: string): string {
  const path = join(folder, name)
  writeFileSync(path, name)
  return path
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-producers-')))
  folder = join(root, 'w1')
  mkdirSync(folder)
})

describe('ArtifactProducers', () => {
  it('PRT-C56 credits a file to the pane that opened it, also after a restart', () => {
    const plan = write('plan.md')
    expect(producers().note('w1', 'pane-a', plan)).toBe(true)
    expect(producers().of('w1')).toEqual({ [plan]: 'pane-a' })
    const saved = join(root, '.history', 'w1', 'producers.json')
    expect(statSync(saved).mode & 0o777).toBe(0o600)
  })

  it('PRT-C57 keeps the first pane, and credits nobody for a file no pane opened', () => {
    const plan = write('plan.md')
    write('unopened.md')
    const p = producers()
    p.note('w1', 'pane-a', plan)
    expect(p.note('w1', 'pane-b', plan)).toBe(false)
    expect(p.of('w1')).toEqual({ [plan]: 'pane-a' })
    expect(p.note('w1', 'pane-a', join(root, 'elsewhere.md'))).toBe(false)
    expect(Object.keys(p.of('w1'))).toEqual([plan])
  })

  it('PRT-C58 forgets a closed pane and a deleted file', () => {
    const plan = write('plan.md')
    const notes = write('notes.md')
    const p = producers()
    p.note('w1', 'pane-a', plan)
    p.note('w1', 'pane-b', notes)
    p.paneClosed('pane-a')
    expect(p.of('w1')).toEqual({ [notes]: 'pane-b' })
    rmSync(notes)
    expect(p.of('w1')).toEqual({})
    expect(producers().of('w1')).toEqual({})
  })

  it('PRT-C76 follows a merge through the moved names', () => {
    const into = join(root, 'w2')
    mkdirSync(into)
    const plan = write('plan.md')
    mkdirSync(join(folder, 'sub'))
    const nested = join(folder, 'sub', 'notes.md')
    writeFileSync(nested, 'notes')
    const p = new ArtifactProducers({
      file: (workspaceId) => join(root, '.history', workspaceId, 'producers.json'),
      folderOf: (workspaceId) =>
        workspaceId === 'w1' ? folder : workspaceId === 'w2' ? into : null,
    })
    p.note('w1', 'pane-a', plan)
    p.note('w1', 'pane-b', nested)
    writeFileSync(join(into, 'plan-2.md'), 'moved')
    mkdirSync(join(into, 'sub-2'))
    writeFileSync(join(into, 'sub-2', 'notes.md'), 'moved')
    p.merge('w1', 'w2', [
      ['plan.md', 'plan-2.md'],
      ['sub', 'sub-2'],
    ])
    expect(p.of('w2')).toEqual({
      [join(into, 'plan-2.md')]: 'pane-a',
      [join(into, 'sub-2', 'notes.md')]: 'pane-b',
    })
  })
})
