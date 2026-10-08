import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() }, shell: {} }))

import { ARTIFACT_KEEP_CLOSED_MS, ARTIFACT_LIST_MAX, PAD_FILE } from '../shared/artifacts'
import { ArtifactFolders, listArtifacts } from './artifactFolders'

let base: string
let root: string
let scratch: string
let now: number
let folders: ArtifactFolders

function stamped(path: string, seconds: number, content = 'x'): void {
  writeFileSync(path, content)
  utimesSync(path, seconds, seconds)
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ostia-artifacts-test-'))
  root = join(base, 'artifacts')
  scratch = join(base, 'scratch')
  mkdirSync(scratch)
  now = 1_000_000
  folders = new ArtifactFolders({
    root,
    scratchDirOf: (id) => (id === 'w-scratch' ? scratch : null),
    now: () => now,
  })
})

afterEach(() => {
  folders.dispose()
  rmSync(base, { recursive: true, force: true })
})

describe('ArtifactFolders', () => {
  it('makes one private folder per workspace under the root', () => {
    const dir = folders.ensure('w1')
    expect(dir).toBe(join(root, 'w1'))
    expect(statSync(join(root, 'w1')).mode & 0o777).toBe(0o700)
    expect(folders.ensure('w1')).toBe(dir)
    expect(folders.ensure('w2')).toBe(join(root, 'w2'))
  })

  it('keeps a scratch workspace’s folder inside its scratch folder', () => {
    expect(folders.ensure('w-scratch')).toBe(join(scratch, 'artifacts'))
    expect(existsSync(join(root, 'w-scratch'))).toBe(false)
  })

  it('refuses a workspace id that could leave the root', () => {
    for (const id of ['', '..', '../x', 'a/b', '.closed', 'w 1']) {
      expect(folders.ensure(id), id).toBeNull()
    }
    expect(existsSync(join(base, 'x'))).toBe(false)
  })

  it('refuses a folder that is a symlink', () => {
    mkdirSync(root)
    symlinkSync(base, join(root, 'w1'))
    expect(folders.ensure('w1')).toBeNull()
  })

  it('lists regular files of the folder and one level down, newest first, without the pad', () => {
    const dir = folders.ensure('w1') as string
    stamped(join(dir, 'old.md'), 100)
    stamped(join(dir, 'new.md'), 300)
    stamped(join(dir, PAD_FILE), 400)
    mkdirSync(join(dir, 'page'))
    stamped(join(dir, 'page', 'index.html'), 200)
    mkdirSync(join(dir, 'page', 'deep'))
    stamped(join(dir, 'page', 'deep', 'hidden.js'), 500)
    symlinkSync('/etc/hostname', join(dir, 'link.txt'))
    symlinkSync('/etc', join(dir, 'etc'))
    const listing = folders.listing('w1')
    expect(listing?.pad).toBe(join(dir, PAD_FILE))
    expect(listing?.entries.map((e) => e.name)).toEqual(['new.md', 'page/index.html', 'old.md'])
    expect(listing?.entries[0]).toMatchObject({ path: join(dir, 'new.md'), size: 1 })
  })

  it('lists at most the newest 200 files', () => {
    const dir = folders.ensure('w1') as string
    for (let i = 0; i < ARTIFACT_LIST_MAX + 5; i += 1) stamped(join(dir, `f${i}.md`), 1000 + i)
    const names = listArtifacts(dir).map((e) => e.name)
    expect(names).toHaveLength(ARTIFACT_LIST_MAX)
    expect(names[0]).toBe(`f${ARTIFACT_LIST_MAX + 4}.md`)
    expect(names).not.toContain('f0.md')
  })

  it('creates the pad once and never overwrites it', () => {
    const pad = folders.ensurePad('w1') as string
    expect(pad).toBe(join(root, 'w1', PAD_FILE))
    expect(readFileSync(pad, 'utf8')).toBe('')
    writeFileSync(pad, 'kept')
    expect(folders.ensurePad('w1')).toBe(pad)
    expect(readFileSync(pad, 'utf8')).toBe('kept')
  })

  it('refuses a pad that is a symlink', () => {
    const dir = folders.ensure('w1') as string
    symlinkSync('/etc/hostname', join(dir, PAD_FILE))
    expect(folders.ensurePad('w1')).toBeNull()
  })

  it('moves a closed workspace’s files aside and removes an empty folder at once', () => {
    const kept = folders.ensure('w1') as string
    writeFileSync(join(kept, 'report.md'), 'r')
    const empty = folders.ensure('w2') as string
    folders.close('w1')
    folders.close('w2')
    expect(existsSync(kept)).toBe(false)
    expect(existsSync(empty)).toBe(false)
    expect(readdirSync(join(root, '.closed'))).toEqual([`w1-${now}`])
    expect(readFileSync(join(root, '.closed', `w1-${now}`, 'report.md'), 'utf8')).toBe('r')
    expect(folders.listing('w1')?.entries).toEqual([])
  })

  it('leaves a scratch workspace’s folder to the scratch folder', () => {
    const dir = folders.ensure('w-scratch') as string
    writeFileSync(join(dir, 'a.md'), 'a')
    folders.close('w-scratch')
    expect(existsSync(join(dir, 'a.md'))).toBe(true)
    expect(existsSync(join(root, '.closed'))).toBe(false)
  })

  it('sweeps closed folders only after 14 days', () => {
    const dir = folders.ensure('w1') as string
    writeFileSync(join(dir, 'a.md'), 'a')
    folders.close('w1')
    now += ARTIFACT_KEEP_CLOSED_MS - 1
    expect(folders.sweep()).toEqual([])
    now += 1
    expect(folders.sweep()).toEqual([join(root, '.closed', 'w1-1000000')])
    expect(readdirSync(join(root, '.closed'))).toEqual([])
  })

  it('moves a merged workspace’s files into the target, renaming on a clash, and keeps one pad', () => {
    const source = folders.ensure('w1') as string
    const target = folders.ensure('w2') as string
    writeFileSync(join(source, 'report.md'), 'from source')
    writeFileSync(join(source, 'only.md'), 'only')
    writeFileSync(join(source, PAD_FILE), 'source pad')
    writeFileSync(join(target, 'report.md'), 'from target')
    writeFileSync(join(target, PAD_FILE), 'target pad')
    folders.merge('w1', 'w2')
    expect(readdirSync(target).sort()).toEqual([PAD_FILE, 'only.md', 'report-2.md', 'report.md'])
    expect(readFileSync(join(target, 'report.md'), 'utf8')).toBe('from target')
    expect(readFileSync(join(target, 'report-2.md'), 'utf8')).toBe('from source')
    expect(readFileSync(join(target, PAD_FILE), 'utf8')).toBe('target pad')
  })

  it('reports a change in a watched folder, and stops once the workspace closes', async () => {
    const changed: string[] = []
    const watching = new ArtifactFolders({ root, scratchDirOf: () => null }, (id) =>
      changed.push(id),
    )
    const dir = watching.ensure('w1') as string
    writeFileSync(join(dir, 'a.md'), 'a')
    await vi.waitFor(() => expect(changed).toEqual(['w1']))
    watching.close('w1')
    changed.length = 0
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'b.md'), 'b')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(changed).toEqual([])
    watching.dispose()
  })
})
