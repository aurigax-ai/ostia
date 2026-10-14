import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
})
