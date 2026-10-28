import { DEFAULT_DEVICE, rotated } from '@shared/browser/browserDevice'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  firstPaneOfKind,
  followMovedFile,
  hasLockedPane,
  renamePane,
  setPaneBrowser,
  setPaneBrowserDevice,
  setPaneCwd,
  setPaneDiff,
  setPaneEditor,
  setPaneHibernated,
  setPaneKeepAwake,
  setPaneLocked,
  setPaneResume,
  setPaneSpawnDir,
  setPaneTitle,
  setPaneUrl,
  settleSpawnDir,
} from './paneFields'
import { createPane, findPane, resetIds, splitOf, tabsOf } from './tree'
import type { LayoutNode } from './types'

beforeEach(() => resetIds())

describe('setPaneCwd', () => {
  it('sets cwd on the matching leaf, leaving siblings untouched', () => {
    const a = createPane()
    const b = createPane()
    const root = splitOf('horizontal', a, b)
    const next = setPaneCwd(root, b.id, '/work/api')
    expect(findPane(next, b.id)?.cwd).toBe('/work/api')
    expect(findPane(next, a.id)?.cwd).toBeUndefined()
  })

  it('sets cwd when the root pane itself matches', () => {
    const root = createPane()
    const next = setPaneCwd(root, root.id, '/home')
    expect(next).not.toBe(root)
    expect(findPane(next, root.id)?.cwd).toBe('/home')
  })

  it('returns the same lone root pane when the id does not match', () => {
    const root = createPane()
    expect(setPaneCwd(root, 'ghost', '/x')).toBe(root)
  })

  it('returns the identical tree when the cwd is unchanged', () => {
    const a = createPane('terminal', undefined, '/work')
    const b = createPane('terminal', undefined, '/home')
    const root = splitOf('horizontal', a, splitOf('vertical', b, createPane()))
    expect(setPaneCwd(root, b.id, '/home')).toBe(root)
  })

  it('keeps untouched subtrees referentially identical when one cwd changes', () => {
    const a = createPane()
    const inner = splitOf('vertical', createPane(), createPane())
    const root = splitOf('horizontal', a, inner)
    const next = setPaneCwd(root, a.id, '/x')
    expect(next).not.toBe(root)
    expect(next.type === 'split' && next.children[1]).toBe(inner)
  })
})

describe('renamePane', () => {
  it('pins the new title so program titles no longer replace it', () => {
    const pane = { ...createPane('terminal'), defaultTitle: true as const }
    const root = splitOf('horizontal', createPane(), pane)
    const renamed = renamePane(root, pane.id, '  W9 控制面補齊 ')
    expect(findPane(renamed, pane.id)).toMatchObject({
      title: 'W9 控制面補齊',
      titlePinned: true,
    })
    expect(findPane(renamed, pane.id)).not.toHaveProperty('defaultTitle')
    const after = setPaneTitle(renamed, pane.id, 'vim README.md')
    expect(after).toBe(renamed)
  })

  it('unpins on an empty title and keeps the current one until a program sets another', () => {
    const pane = createPane('terminal')
    const root = renamePane(splitOf('horizontal', createPane(), pane), pane.id, 'worker')
    const cleared = renamePane(root, pane.id, '')
    expect(findPane(cleared, pane.id)).not.toHaveProperty('titlePinned')
    expect(findPane(cleared, pane.id)?.title).toBe('worker')
    expect(findPane(setPaneTitle(cleared, pane.id, 'htop'), pane.id)?.title).toBe('htop')
  })

  it('returns the identical tree when nothing changes', () => {
    const pane = createPane('terminal')
    const root = renamePane(splitOf('horizontal', createPane(), pane), pane.id, 'worker')
    expect(renamePane(root, pane.id, 'worker')).toBe(root)
    const plain = splitOf('horizontal', createPane(), createPane())
    expect(renamePane(plain, 'missing', '')).toBe(plain)
  })
})

describe('setPaneUrl', () => {
  it('updates the url of the matching pane and keeps its title', () => {
    const pane = createPane('browser', 'example.com')
    const root = splitOf('horizontal', createPane(), pane)
    const next = setPaneUrl(root, pane.id, 'https://example.com/next')
    expect(findPane(next, pane.id)?.url).toBe('https://example.com/next')
    expect(findPane(next, pane.id)?.title).toBe('example.com')
  })

  it('returns the identical tree when the url is unchanged', () => {
    const pane = { ...createPane('browser'), url: 'https://a.test/' }
    const root = splitOf('horizontal', createPane(), pane)
    expect(setPaneUrl(root, pane.id, 'https://a.test/')).toBe(root)
  })
})

describe('firstPaneOfKind', () => {
  it('returns the first pane of the kind in tree order, descending into splits', () => {
    const t1 = createPane('terminal')
    const e1 = createPane('editor')
    const e2 = createPane('editor')
    const root = splitOf('horizontal', t1, splitOf('vertical', e1, e2))
    expect(firstPaneOfKind(root, 'editor')).toBe(e1)
  })

  it('returns the root pane when it matches the kind', () => {
    const root = createPane('agent')
    expect(firstPaneOfKind(root, 'agent')).toBe(root)
  })

  it('returns null when no pane has the kind', () => {
    const root = splitOf('horizontal', createPane('terminal'), createPane('terminal'))
    expect(firstPaneOfKind(root, 'browser')).toBeNull()
  })
})

describe('setPaneEditor', () => {
  it('turns the matching pane into an editor and derives cwd from the file dir', () => {
    const a = createPane('terminal')
    const b = createPane('terminal')
    const root = splitOf('horizontal', a, b)
    const next = setPaneEditor(root, b.id, 'main.ts', '/src/app/main.ts')
    const pane = findPane(next, b.id)
    expect(pane?.kind).toBe('editor')
    expect(pane?.title).toBe('main.ts')
    expect(pane?.filePath).toBe('/src/app/main.ts')
    expect(pane?.cwd).toBe('/src/app')
    expect(findPane(next, a.id)?.kind).toBe('terminal')
  })

  it('gives a remote file no folder, so it never moves the local tree or workspace', () => {
    const term = createPane('terminal', 'zsh', '/home/u/proj')
    const next = setPaneEditor(term, term.id, 'app.conf', 'remote://abcdef012345/srv/app/app.conf')
    const pane = findPane(next, term.id)
    expect(pane?.kind).toBe('editor')
    expect(pane?.filePath).toBe('remote://abcdef012345/srv/app/app.conf')
    expect(pane && 'cwd' in pane).toBe(false)
  })

  it('falls back to root cwd for a file at the filesystem root', () => {
    const root = createPane('terminal')
    const next = setPaneEditor(root, root.id, 'notes.txt', '/notes.txt')
    const pane = findPane(next, root.id)
    expect(pane?.kind).toBe('editor')
    expect(pane?.cwd).toBe('/')
  })

  it('falls back to root cwd for a bare file name with no slash', () => {
    const root = createPane('terminal')
    const pane = findPane(setPaneEditor(root, root.id, 'notes.txt', 'notes.txt'), root.id)
    expect(pane?.cwd).toBe('/')
  })

  it('leaves a non-matching lone pane unchanged', () => {
    const root = createPane('terminal')
    expect(setPaneEditor(root, 'ghost', 't', '/a/t.ts')).toBe(root)
  })
})

describe('setPaneBrowser', () => {
  it('turns the matching pane into a browser and derives the title from the URL host', () => {
    const a = createPane('terminal')
    const b = createPane('terminal')
    const root = splitOf('horizontal', a, b)
    const next = setPaneBrowser(root, b.id, 'https://example.com/path?q=1')
    const pane = findPane(next, b.id)
    expect(pane?.kind).toBe('browser')
    expect(pane?.url).toBe('https://example.com/path?q=1')
    expect(pane?.title).toBe('example.com')
    expect(findPane(next, a.id)?.kind).toBe('terminal')
  })

  it('falls back to the raw string as the title when the URL is unparseable', () => {
    const root = createPane('terminal')
    const next = setPaneBrowser(root, root.id, 'about:blank')
    const pane = findPane(next, root.id)
    expect(pane?.kind).toBe('browser')
    expect(pane?.url).toBe('about:blank')
    expect(pane?.title).toBe('about:blank')
  })

  it('leaves a non-matching lone pane unchanged', () => {
    const root = createPane('terminal')
    expect(setPaneBrowser(root, 'ghost', 'https://example.com')).toBe(root)
  })
})

describe('setPaneBrowserDevice', () => {
  function browserPane(): LayoutNode {
    const root = createPane('terminal')
    return setPaneBrowser(root, root.id, 'https://example.com')
  }

  it('saves the device on a browser pane and removes the field when it goes off', () => {
    const root = browserPane()
    const on = setPaneBrowserDevice(root, root.id, DEFAULT_DEVICE)
    expect(findPane(on, root.id)?.browserDevice).toEqual(DEFAULT_DEVICE)
    const turned = setPaneBrowserDevice(on, root.id, rotated(DEFAULT_DEVICE))
    expect(findPane(turned, root.id)?.browserDevice).toMatchObject({ width: 800, height: 400 })
    const off = setPaneBrowserDevice(turned, root.id, null)
    expect(findPane(off, root.id)).not.toHaveProperty('browserDevice')
  })

  it('returns the same tree when nothing changes or the pane is not a browser', () => {
    const root = browserPane()
    expect(setPaneBrowserDevice(root, root.id, null)).toBe(root)
    const on = setPaneBrowserDevice(root, root.id, DEFAULT_DEVICE)
    expect(setPaneBrowserDevice(on, root.id, { ...DEFAULT_DEVICE })).toBe(on)
    const terminal = createPane('terminal')
    expect(setPaneBrowserDevice(terminal, terminal.id, DEFAULT_DEVICE)).toBe(terminal)
  })
})

describe('setPaneDiff', () => {
  it('turns the pane into a diff surface, dropping fields of its previous surface', () => {
    const editor = { ...createPane('editor', 'a.ts', '/p'), filePath: '/p/a.ts' }
    const other = createPane()
    const root = splitOf('horizontal', editor, other)
    const next = setPaneDiff(root, editor.id, 'a.ts (diff)', '/repo')
    expect(findPane(next, editor.id)).toEqual({
      type: 'pane',
      id: editor.id,
      kind: 'diff',
      title: 'a.ts (diff)',
      cwd: '/repo',
    })
    expect(next.type === 'split' && next.children[1]).toBe(other)
  })
})

describe('setPaneLocked', () => {
  it('marks and clears a pane, returning the same tree when nothing changes', () => {
    const a = createPane()
    const b = createPane()
    const root = tabsOf(a.id, a, b)
    expect(hasLockedPane(root)).toBe(false)
    const locked = setPaneLocked(root, b.id, true)
    expect(findPane(locked, b.id)).toMatchObject({ locked: true })
    expect(hasLockedPane(locked)).toBe(true)
    expect(setPaneLocked(locked, b.id, true)).toBe(locked)
    const open = setPaneLocked(locked, b.id, false)
    expect(findPane(open, b.id)).not.toHaveProperty('locked')
    expect(hasLockedPane(open)).toBe(false)
  })
})

describe('setPaneKeepAwake', () => {
  it('marks and clears a pane, returning the same tree when nothing changes', () => {
    const root = createPane()
    const kept = setPaneKeepAwake(root, root.id, true)
    expect(kept).toMatchObject({ keepAwake: true })
    expect(setPaneKeepAwake(kept, root.id, true)).toBe(kept)
    const open = setPaneKeepAwake(kept, root.id, false)
    expect(open).not.toHaveProperty('keepAwake')
    expect(setPaneKeepAwake(open, root.id, false)).toBe(open)
  })

  it('stays when the same agent stores a new session and drops when another agent starts', () => {
    const root = { ...createPane(), resume: { agent: 'claude' as const, id: 'a' } }
    const kept = setPaneKeepAwake(root, root.id, true)
    const sameAgent = setPaneResume(kept, root.id, { agent: 'claude', id: 'b' })
    expect(sameAgent).toMatchObject({ keepAwake: true, resume: { id: 'b' } })
    const otherAgent = setPaneResume(kept, root.id, { agent: 'codex', id: 'c' })
    expect(otherAgent).not.toHaveProperty('keepAwake')
    expect(otherAgent).toMatchObject({ resume: { agent: 'codex', id: 'c' } })
  })
})

describe('setPaneHibernated', () => {
  it('marks and clears a pane, returning the same tree when nothing changes', () => {
    const root = createPane()
    const asleep = setPaneHibernated(root, root.id, true)
    expect(asleep).toMatchObject({ hibernated: true })
    expect(setPaneHibernated(asleep, root.id, true)).toBe(asleep)
    const awake = setPaneHibernated(asleep, root.id, false)
    expect(awake).not.toHaveProperty('hibernated')
    expect(setPaneHibernated(awake, root.id, false)).toBe(awake)
  })

  it('wakes a pane whose token names a folder with the next shell starting there', () => {
    const root = {
      ...createPane(),
      cwd: '/w',
      resume: { agent: 'claude' as const, id: 'a', cwd: '/w/t' },
    }
    const awake = setPaneHibernated(setPaneHibernated(root, root.id, true), root.id, false)
    expect(awake).toMatchObject({ cwd: '/w', spawnDir: '/w/t' })
  })
})

describe('settleSpawnDir', () => {
  it('starts a pane in a given folder, the same object when it already is', () => {
    const root = createPane()
    const placed = setPaneSpawnDir(root, root.id, '/w/t')
    expect(placed).toMatchObject({ spawnDir: '/w/t' })
    expect(setPaneSpawnDir(placed, root.id, '/w/t')).toBe(placed)
  })

  it('drops the spawn folder once the shell started, keeping it as missing only when it was gone', () => {
    const root = { ...createPane(), spawnDir: '/w/t' }
    expect(settleSpawnDir(root, root.id, false)).not.toHaveProperty('spawnDir')
    const gone = settleSpawnDir(root, root.id, true)
    expect(gone).not.toHaveProperty('spawnDir')
    expect(gone).toMatchObject({ resumeFolderMissing: '/w/t' })
    expect(settleSpawnDir(gone, root.id, true)).toBe(gone)
  })

  it('clears the missing folder when the shell reports that folder again', () => {
    const root = { ...createPane(), resumeFolderMissing: '/w/t' }
    expect(setPaneCwd(root, root.id, '/home')).toMatchObject({ resumeFolderMissing: '/w/t' })
    expect(setPaneCwd(root, root.id, '/w/t')).not.toHaveProperty('resumeFolderMissing')
  })
})

describe('followMovedFile', () => {
  it('points editors at a renamed file and at files under a moved folder', () => {
    const file = { ...createPane('editor'), filePath: '/p/notes.md', title: 'notes.md' }
    const nested = { ...createPane('editor'), filePath: '/p/src/main.ts', title: 'main.ts' }
    const other = { ...createPane('editor'), filePath: '/p/srcx/a.ts', title: 'a.ts' }
    const root = splitOf('horizontal', file, splitOf('vertical', nested, other))

    const renamed = followMovedFile(root, '/p/notes.md', '/p/readme.md')
    expect(JSON.stringify(renamed)).toContain('"filePath":"/p/readme.md"')
    expect(JSON.stringify(renamed)).toContain('"title":"readme.md"')

    const moved = followMovedFile(root, '/p/src', '/p/lib')
    expect(JSON.stringify(moved)).toContain('"filePath":"/p/lib/main.ts"')
    expect(JSON.stringify(moved)).toContain('"filePath":"/p/srcx/a.ts"')
  })

  it('returns the same tree when no editor shows the moved path', () => {
    const root = splitOf('horizontal', createPane(), createPane())
    expect(followMovedFile(root, '/p/a', '/p/b')).toBe(root)
  })
})
