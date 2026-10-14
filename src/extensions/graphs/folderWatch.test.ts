import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const hasMkfifo = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v mkfifo'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
import { FolderWatcher } from './folderWatch'

const roots: string[] = []
const watchers: FolderWatcher[] = []

afterEach(() => {
  for (const w of watchers.splice(0)) w.stop()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), 'graphs-watch-'))
  roots.push(root)
  for (const dir of ['src/a', '.git/objects', 'node_modules/x', 'build/out']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  writeFileSync(join(root, '.gitignore'), 'build/\n*.log\n')
  return root
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
}

describe('the folder watcher of a files trigger', () => {
  it('reports changes outside .git, node_modules and gitignored paths', async () => {
    const root = folder()
    const seen: string[] = []
    const watcher = new FolderWatcher(
      root,
      (rel) => seen.push(rel),
      () => {},
    )
    watchers.push(watcher)
    expect(watcher.start()).toEqual({ ok: true, folders: 3 })
    writeFileSync(join(root, 'node_modules/x/i.js'), '1')
    writeFileSync(join(root, '.git/objects/o'), '1')
    writeFileSync(join(root, 'build/out/b.ts'), '1')
    writeFileSync(join(root, 'src/a/debug.log'), '1')
    writeFileSync(join(root, 'src/a/b.ts'), '1')
    await until(() => seen.includes('src/a/b.ts'))
    await new Promise((r) => setTimeout(r, 100))
    expect([...new Set(seen)]).toEqual(['src/a/b.ts'])
  })

  it('watches a folder made after it started', async () => {
    const root = folder()
    const seen: string[] = []
    const watcher = new FolderWatcher(
      root,
      (rel) => seen.push(rel),
      () => {},
    )
    watchers.push(watcher)
    watcher.start()
    mkdirSync(join(root, 'src/new'))
    await new Promise((r) => setTimeout(r, 100))
    writeFileSync(join(root, 'src/new/c.ts'), '1')
    await until(() => seen.includes('src/new/c.ts'))
    expect(seen).toContain('src/new/c.ts')
  })

  it('refuses a folder with more folders than it may watch', () => {
    const root = folder()
    for (let i = 0; i < 6; i++) mkdirSync(join(root, `src/d${i}`))
    const watcher = new FolderWatcher(
      root,
      () => {},
      () => {},
      5,
    )
    watchers.push(watcher)
    expect(watcher.start()).toEqual({ ok: false, reason: 'too-many-folders' })
  })

  it('never follows a link to a folder outside the workspace, made before or after it started', async () => {
    const root = folder()
    const outside = mkdtempSync(join(tmpdir(), 'graphs-outside-'))
    roots.push(outside)
    symlinkSync(outside, join(root, 'src/before'))
    const seen: string[] = []
    const watcher = new FolderWatcher(
      root,
      (rel) => seen.push(rel),
      () => {},
    )
    watchers.push(watcher)
    expect(watcher.start()).toEqual({ ok: true, folders: 3 })
    symlinkSync(outside, join(root, 'src/after'))
    await new Promise((r) => setTimeout(r, 150))
    writeFileSync(join(outside, 'secret.ts'), '1')
    writeFileSync(join(root, 'src/a/b.ts'), '1')
    await until(() => seen.includes('src/a/b.ts'))
    await new Promise((r) => setTimeout(r, 150))
    expect(seen.filter((p) => p.startsWith('src/before') || p.startsWith('src/after'))).toEqual([])
    expect(watcher.watching()).toBe(3)
  })

  it('reads no .gitignore that is a link, so rules from a file outside are never applied', async () => {
    const root = folder()
    const outside = mkdtempSync(join(tmpdir(), 'graphs-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'rules'), 'src/\n')
    rmSync(join(root, '.gitignore'))
    symlinkSync(join(outside, 'rules'), join(root, '.gitignore'))
    const seen: string[] = []
    const watcher = new FolderWatcher(
      root,
      (rel) => seen.push(rel),
      () => {},
    )
    watchers.push(watcher)
    expect(watcher.start()).toEqual({ ok: true, folders: 5 })
    expect(watcher.ignored('src/a/b.ts', false)).toBe(false)
    writeFileSync(join(root, 'src/a/b.ts'), '1')
    await until(() => seen.includes('src/a/b.ts'))
    expect(seen).toContain('src/a/b.ts')
  })

  it.skipIf(!hasMkfifo)('never blocks on a .gitignore that is a fifo', () => {
    const root = folder()
    rmSync(join(root, '.gitignore'))
    execFileSync('mkfifo', [join(root, '.gitignore')])
    const watcher = new FolderWatcher(
      root,
      () => {},
      () => {},
    )
    watchers.push(watcher)
    const started = Date.now()
    expect(watcher.start()).toEqual({ ok: true, folders: 5 })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(watcher.ignored('build/out/b.ts', false)).toBe(false)
  })

  it('drops the watchers of a removed folder and watches it again when it comes back', async () => {
    const root = folder()
    mkdirSync(join(root, 'src/a/deep'))
    const seen: string[] = []
    const watcher = new FolderWatcher(
      root,
      (rel) => seen.push(rel),
      () => {},
    )
    watchers.push(watcher)
    expect(watcher.start()).toEqual({ ok: true, folders: 4 })
    rmSync(join(root, 'src/a'), { recursive: true, force: true })
    await until(() => watcher.watching() === 2)
    expect(watcher.watching()).toBe(2)
    mkdirSync(join(root, 'src/a'))
    await until(() => watcher.watching() === 3)
    writeFileSync(join(root, 'src/a/c.ts'), '1')
    await until(() => seen.includes('src/a/c.ts'))
    expect(seen).toContain('src/a/c.ts')
    expect(watcher.watching()).toBe(3)
  })
})
