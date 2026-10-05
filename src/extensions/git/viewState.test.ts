import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_REMEMBERED_REPOS, ViewStateStore, parseViewState } from './viewState'

describe('parseViewState', () => {
  it('starts with no chosen branches', () => {
    expect(parseViewState(null)).toEqual({ chosen: {} })
  })

  it('keeps valid branch lists per absolute repository root and drops the rest', () => {
    expect(
      parseViewState({
        chosen: {
          '/r/a': ['refs/heads/main', '--all'],
          '/r/b': ['--all'],
          relative: ['refs/heads/main'],
        },
      }),
    ).toEqual({ chosen: { '/r/a': ['refs/heads/main'] } })
  })
})

describe('ViewStateStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-git-view-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('remembers chosen branches per repository across restarts', () => {
    const file = join(dir, 'sub', 'view.json')
    const store = new ViewStateStore(file)
    expect(store.chosenFor('/r/a')).toBeNull()
    store.setChosen('/r/a', ['refs/heads/x'])
    store.setChosen('/r/b', ['refs/remotes/origin/main'])
    const again = new ViewStateStore(file)
    expect(again.chosenFor('/r/a')).toEqual(['refs/heads/x'])
    expect(again.chosenFor('/r/b')).toEqual(['refs/remotes/origin/main'])
    again.setChosen('/r/b', null)
    expect(JSON.parse(readFileSync(file, 'utf8')).chosen).not.toHaveProperty('/r/b')
  })

  it('forgets the oldest repositories past the cap', () => {
    const store = new ViewStateStore(join(dir, 'view.json'))
    for (let i = 0; i <= MAX_REMEMBERED_REPOS; i++) store.setChosen(`/r/${i}`, ['refs/heads/m'])
    expect(store.chosenFor('/r/0')).toBeNull()
    expect(store.chosenFor(`/r/${MAX_REMEMBERED_REPOS}`)).toEqual(['refs/heads/m'])
  })

  it('starts empty when the file is unreadable', () => {
    const file = join(dir, 'view.json')
    writeFileSync(file, '{nope')
    expect(new ViewStateStore(file).chosenFor('/r/a')).toBeNull()
  })
})
