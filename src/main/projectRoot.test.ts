import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const { describeProject, findProjectRoot } = await import('./projectRoot')

const repos = new Set(['/home/u/Personal/model-runtime/.git', '/home/u/.git'])
const hasGit = (p: string) => repos.has(p)

describe('findProjectRoot', () => {
  it('finds the nearest folder with .git below home', () => {
    expect(findProjectRoot('/home/u/Personal/model-runtime/src/cli', '/home/u', hasGit)).toBe(
      '/home/u/Personal/model-runtime',
    )
  })

  it('never treats home itself as a project, even when it has .git', () => {
    expect(findProjectRoot('/home/u/Personal/notes', '/home/u', hasGit)).toBeNull()
    expect(findProjectRoot('/home/u', '/home/u', hasGit)).toBeNull()
  })
})

describe('describeProject', () => {
  it('names a repository by its folder and shortens its path', () => {
    expect(describeProject('/home/u/p/app/src', '/home/u', '/home/u/p/app')).toEqual({
      name: 'app',
      display: '~/p/app',
      dir: '/home/u/p/app',
      repo: true,
    })
  })

  it('falls back to the folder itself, and calls home "home"', () => {
    expect(describeProject('/home/u/Downloads', '/home/u', null)).toEqual({
      name: 'Downloads',
      display: '~/Downloads',
      dir: '/home/u/Downloads',
      repo: false,
    })
    expect(describeProject('/home/u', '/home/u', null)).toEqual({
      name: 'home',
      display: '~',
      dir: '/home/u',
      repo: false,
    })
  })
})
