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

import {
  ARTIFACT_KEEP_CLOSED_MS,
  ARTIFACT_LIST_MAX,
  PAD_FILE,
} from '../../shared/artifacts/artifacts'
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
    scratchDirs: () => [scratch],
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

  it('follows an existing folder for a reader without making a missing one', async () => {
    const reports: string[] = []
    const reading = new ArtifactFolders(
      { root, scratchDirOf: () => null, scratchDirs: () => [] },
      (_id, changes) => reports.push(...changes.map((c) => `${c.change} ${c.path}`)),
    )
    expect(reading.followed('w7')).toBe(join(root, 'w7'))
    expect(existsSync(join(root, 'w7'))).toBe(false)
    mkdirSync(join(root, 'w8'), { recursive: true })
    reading.followed('w8')
    await vi.waitFor(
      () => {
        stamped(join(root, 'w8', 'a.md'), 100)
        expect(reports).toEqual(['added a.md'])
      },
      { timeout: 10_000 },
    )
    reading.dispose()
  })

  it('gives a reader nothing when the artifact folder was replaced by a symlink', () => {
    mkdirSync(root, { recursive: true })
    symlinkSync(base, join(root, 'w5'))
    expect(folders.followed('w5')).toBeNull()
  })

  it('knows which folders are artifact folders: its own and a scratch workspace’s, never closed ones', () => {
    expect(folders.holds(join(root, 'w1'))).toBe(true)
    expect(folders.holds(join(root, 'w1', 'page'))).toBe(true)
    expect(folders.holds(join(scratch, 'artifacts'))).toBe(true)
    expect(folders.holds(scratch)).toBe(false)
    expect(folders.holds(root)).toBe(false)
    expect(folders.holds(join(root, '.closed', 'w1-5'))).toBe(false)
    expect(folders.holds(base)).toBe(false)
    expect(folders.holds(`${root}-other/w1`)).toBe(false)
  })

  it('reports no change for files beyond the 200 the list shows', async () => {
    const reports: { path: string; change: string }[] = []
    const watching = new ArtifactFolders(
      { root, scratchDirOf: () => null, scratchDirs: () => [] },
      (_id, changes) => reports.push(...changes),
    )
    mkdirSync(join(root, 'w1'), { recursive: true })
    for (let i = 0; i < ARTIFACT_LIST_MAX + 30; i += 1)
      stamped(join(root, 'w1', `f${i}.md`), 1000 + i)
    const dir = watching.ensure('w1') as string
    await vi.waitFor(
      () => {
        stamped(join(dir, 'newest.md'), 9000)
        expect(reports.length).toBeGreaterThan(0)
      },
      { timeout: 10_000 },
    )
    expect(reports).toEqual([{ path: 'newest.md', change: 'added' }])
    watching.dispose()
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
    expect(listing?.padModified).toBe(400_000)
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
    expect(folders.listing('w1')?.padModified).toBeNull()
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

  it('reports what was added, changed and removed in a watched folder, and stops once the workspace closes', async () => {
    const reports: [string, { path: string; change: string }[]][] = []
    const watching = new ArtifactFolders(
      { root, scratchDirOf: () => null, scratchDirs: () => [] },
      (id, changes) => reports.push([id, changes]),
    )
    const dir = watching.ensure('w1') as string
    const seen = (): { path: string; change: string }[] => reports.flatMap(([, changes]) => changes)
    await vi.waitFor(
      () => {
        stamped(join(dir, 'a.md'), 100)
        mkdirSync(join(dir, 'page'), { recursive: true })
        stamped(join(dir, 'page', 'index.html'), 100)
        stamped(join(dir, 'PAD.md'), 100)
        expect(seen().sort((x, y) => x.path.localeCompare(y.path))).toEqual([
          { path: 'a.md', change: 'added' },
          { path: 'PAD.md', change: 'added' },
          { path: 'page/index.html', change: 'added' },
        ])
      },
      { timeout: 10_000 },
    )
    expect(reports.every(([id]) => id === 'w1')).toBe(true)
    reports.length = 0
    stamped(join(dir, 'a.md'), 200)
    rmSync(join(dir, 'page', 'index.html'))
    await vi.waitFor(() =>
      expect(seen().sort((x, y) => x.path.localeCompare(y.path))).toEqual([
        { path: 'a.md', change: 'changed' },
        { path: 'page/index.html', change: 'removed' },
      ]),
    )
    watching.close('w1')
    reports.length = 0
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'b.md'), 'b')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(reports).toEqual([])
    watching.dispose()
  })
})
