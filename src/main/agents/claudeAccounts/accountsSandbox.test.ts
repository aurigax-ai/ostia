import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { storePath } from '../../platform/jsonStore'
import { isInsidePath } from '../../platform/pathGuard'
import { appDataDir } from '../../platform/userDirs'
import { fixedPolicy, folderProblem, protectedPaths, touches } from '../../sandbox/srtConfig'
import { accountsRoot } from './accountProfiles'

const PROFILE = join(accountsRoot(), 'a'.repeat(16))
const base = {
  home: '/home/u',
  dataDirs: [dirname(storePath('workspaces', 'global'))],
  socketPath: '/run/ostia.sock',
  runtimeReads: [],
}

describe('the Claude profiles folder in every sandbox', () => {
  it('is inside the data folder the sandbox is given', () => {
    expect(dirname(storePath('workspaces', 'global'))).toBe(appDataDir())
    expect(isInsidePath(appDataDir(), PROFILE)).toBe(true)
  })

  it('is hidden, so a sandboxed process never sees a sign-in', () => {
    const { hidden } = fixedPolicy(base, null, { gitConfig: false })
    expect(hidden.some((dir) => isInsidePath(dir, join(PROFILE, '.credentials.json')))).toBe(true)
  })

  it('is protected from writes and refused as a sandbox folder', () => {
    expect(touches(join(PROFILE, '.credentials.json'), protectedPaths(base))).toBe(true)
    expect(folderProblem(PROFILE, base)).toBe('ostia-data')
  })
})
