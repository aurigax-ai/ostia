import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OPEN_FILES_COMMAND } from '../shared/openFiles'
import type { CommandResult } from '../shared/types'
import { OpenFileGrants } from './openFileGrants'
import { type ExtensionOpenFileDeps, openFileForExtension } from './openFileMethods'

let base: string
let home: string
let outside: string
let grants: OpenFileGrants
let execCommand: ReturnType<typeof vi.fn<ExtensionOpenFileDeps['execCommand']>>

function deps(): ExtensionOpenFileDeps {
  return { grants, windowOf: (id) => (id === 's1' ? 'w1' : undefined), execCommand }
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-ext-open-')))
  home = join(base, 'home')
  outside = join(base, 'outside')
  mkdirSync(join(home, 'src'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(home, 'src', 'a.ts'), 'a\n')
  writeFileSync(join(outside, 'secret.txt'), 's\n')
  grants = new OpenFileGrants({ roots: () => [home], file: join(base, 'opened-files.json') })
  execCommand = vi.fn(async () => ({ ok: true, result: null }) as CommandResult)
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('openFileForExtension', () => {
  it('opens a file inside the roots in the workspace window, at its line and column', async () => {
    const path = join(home, 'src', 'a.ts')
    const res = await openFileForExtension(deps(), {
      extId: 'search',
      workspaceId: 's1',
      path,
      line: 4,
      column: 2,
    })
    expect(res).toEqual({ ok: true })
    expect(execCommand).toHaveBeenCalledWith(
      { windowId: 'w1', workspaceId: 's1', paneId: null },
      OPEN_FILES_COMMAND,
      { files: [{ path, line: 4, column: 2 }] },
    )
  })

  it('refuses a file outside the roots and grants nothing', async () => {
    const path = join(outside, 'secret.txt')
    const res = await openFileForExtension(deps(), { extId: 'x', workspaceId: 's1', path })
    expect(res).toMatchObject({ ok: false, error: 'outside-roots' })
    expect(grants.confine(path)).toBeNull()
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('refuses a folder and a missing file', async () => {
    for (const path of [join(home, 'src'), join(home, 'gone.ts')]) {
      const res = await openFileForExtension(deps(), { extId: 'x', workspaceId: 's1', path })
      expect(res).toMatchObject({ ok: false, error: 'not-a-file' })
    }
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('refuses a workspace no window holds', async () => {
    const path = join(home, 'src', 'a.ts')
    const res = await openFileForExtension(deps(), { extId: 'x', workspaceId: 'nope', path })
    expect(res).toEqual({ ok: false, error: 'unknown-workspace' })
  })

  it('passes on the renderer refusal', async () => {
    execCommand.mockResolvedValue({
      ok: false,
      error: { code: 'command-failed', message: 'target window not available' },
    })
    const path = join(home, 'src', 'a.ts')
    const res = await openFileForExtension(deps(), { extId: 'x', workspaceId: 's1', path })
    expect(res).toEqual({
      ok: false,
      error: 'command-failed',
      message: 'target window not available',
    })
  })
})
