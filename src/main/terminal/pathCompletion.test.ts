import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SandboxReadRules } from '../sandbox/visibility'
import { COMPLETION_ENTRIES_MAX, type CompletionPane, completionPaths } from './pathCompletion'

const OWNER = '7'
const PANE = 'pane-1'
const runsAsRoot = process.getuid?.() === 0

function paneWith(over: Partial<CompletionPane> = {}) {
  const pane: CompletionPane = {
    owners: new Set([OWNER]),
    localPrompt: true,
    rules: null,
    ...over,
  }
  return (paneId: string) => (paneId === PANE ? pane : null)
}

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-path-completion-')))
})

describe('completionPaths', () => {
  it('lists the names of / with their kinds, a folder outside every file root', async () => {
    const entries = await completionPaths(paneWith(), OWNER, PANE, '/')
    expect(entries.map((e) => e.name).sort()).toEqual(readdirSync('/').sort())
    expect(entries.find((e) => e.name === 'usr')).toEqual({ name: 'usr', dir: true })
    expect(entries.every((e) => Object.keys(e).sort().join() === 'dir,name')).toBe(true)
  })

  it('marks files, folders and links by what the shell would complete them to', async () => {
    mkdirSync(join(root, 'folder'))
    writeFileSync(join(root, 'file.txt'), 'never returned')
    symlinkSync(join(root, 'folder'), join(root, 'to-folder'))
    symlinkSync(join(root, 'file.txt'), join(root, 'to-file'))
    symlinkSync(join(root, 'gone'), join(root, 'dangling'))
    expect(await completionPaths(paneWith(), OWNER, PANE, root)).toEqual([
      { name: 'folder', dir: true },
      { name: 'to-folder', dir: true },
      { name: 'dangling', dir: false },
      { name: 'file.txt', dir: false },
      { name: 'to-file', dir: false },
    ])
  })

  it('refuses a pane the sender does not own, an unknown pane and a busy pane', async () => {
    writeFileSync(join(root, 'a'), '')
    expect(await completionPaths(paneWith(), '8', PANE, root)).toEqual([])
    expect(await completionPaths(paneWith(), OWNER, 'pane-2', root)).toEqual([])
    expect(await completionPaths(paneWith({ localPrompt: false }), OWNER, PANE, root)).toEqual([])
    expect(await completionPaths(paneWith(), OWNER, PANE, root)).toEqual([
      { name: 'a', dir: false },
    ])
  })

  it('refuses what is not a local folder path', async () => {
    writeFileSync(join(root, 'a'), '')
    for (const dir of [null, 7, '', 'remote://x/home', `${root}\0`, join(root, 'a')]) {
      expect(await completionPaths(paneWith(), OWNER, PANE, dir)).toEqual([])
    }
    expect(await completionPaths(paneWith(), OWNER, 5, root)).toEqual([])
  })

  it('caps a large folder', async () => {
    for (let i = 0; i < COMPLETION_ENTRIES_MAX + 25; i++) writeFileSync(join(root, `f${i}`), '')
    expect(await completionPaths(paneWith(), OWNER, PANE, root)).toHaveLength(
      COMPLETION_ENTRIES_MAX,
    )
  })

  it('offers a sandboxed pane only what its policy lets the shell read', async () => {
    const work = join(root, 'home', 'work')
    mkdirSync(join(work, 'src'), { recursive: true })
    mkdirSync(join(root, 'home', '.ssh'))
    writeFileSync(join(root, 'home', '.ssh', 'id_ed25519'), '')
    writeFileSync(join(root, 'home', 'notes.txt'), '')
    mkdirSync(join(root, 'open'))
    writeFileSync(join(root, 'open', 'readme'), '')
    writeFileSync(join(root, 'open', 'secret'), '')
    symlinkSync(join(root, 'home', '.ssh'), join(work, 'keys'))
    symlinkSync(join(work, 'src'), join(work, 'code'))
    const rules: SandboxReadRules = {
      denyRead: [join(root, 'home'), join(root, 'open', 'secret')],
      allowRead: [work],
    }
    const list = (dir: string) => completionPaths(paneWith({ rules }), OWNER, PANE, dir)
    expect(await list(join(root, 'home'))).toEqual([{ name: 'work', dir: true }])
    expect(await list(join(root, 'home', '.ssh'))).toEqual([])
    expect(await list(join(work, 'keys'))).toEqual([])
    expect(await list(join(root, 'open'))).toEqual([{ name: 'readme', dir: false }])
    expect(await list(work)).toEqual([
      { name: 'code', dir: true },
      { name: 'src', dir: true },
      { name: 'keys', dir: false },
    ])
  })

  it.skipIf(runsAsRoot)('returns nothing for a folder that cannot be read', async () => {
    const locked = join(root, 'locked')
    mkdirSync(locked)
    writeFileSync(join(locked, 'inside'), '')
    chmodSync(locked, 0o000)
    try {
      expect(await completionPaths(paneWith(), OWNER, PANE, locked)).toEqual([])
      expect(await completionPaths(paneWith(), OWNER, PANE, join(root, 'missing'))).toEqual([])
    } finally {
      chmodSync(locked, 0o700)
    }
  })
})
