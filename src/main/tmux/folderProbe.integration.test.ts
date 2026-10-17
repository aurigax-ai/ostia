import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { skipWithoutTmux, tmuxPath } from '../../../test/tmux'
import { readFoldersInKeptShells } from './folderProbe'
import { CURRENT_OWNER, keptOwnerFile, readKeptOwner, writeKeptOwner } from './keptOwner'
import { KeptShells } from './keptShells'

const tmux = tmuxPath ?? 'tmux'
const root = mkdtempSync(join(tmpdir(), 'ostia-folder-probe-'))
const dir = join(root, 'sock')
const live: KeptShells[] = []
let names = 0

afterEach(async () => {
  for (const kept of live.splice(0)) await kept.quit()
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

function instance(name: string): KeptShells {
  const kept = new KeptShells({
    dir,
    name,
    program: () => ({ tmux, defaultTerminal: 'screen-256color', env: process.env }),
    log: () => undefined,
  })
  live.push(kept)
  return kept
}

async function startServer(kept: KeptShells): Promise<void> {
  await kept.spawn({
    file: '/bin/sh',
    args: ['-c', 'sleep 60'],
    cwd: root,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    cols: 80,
    rows: 24,
    meta: {
      paneId: 'p1',
      externalId: 'ext-p1',
      workspaceId: 'w1',
      shell: '/bin/sh',
      stateFile: '',
      spawnPath: process.env.PATH ?? '',
    },
  })
}

describe.skipIf(skipWithoutTmux)('kept shells owner and folder probe', () => {
  it('records this Ostia as the owner of a tmux server it starts', async () => {
    const name = `f${names++}`
    const kept = instance(name)
    expect(kept.reattachedFromOtherOwner()).toBe(false)
    await startServer(kept)
    expect(readKeptOwner(keptOwnerFile(dir, name))).toEqual(CURRENT_OWNER)
  })

  it('tells a reattach to a server another Ostia started from one this Ostia started', async () => {
    const name = `f${names++}`
    const first = instance(name)
    await startServer(first)
    first.release()
    const same = instance(name)
    await same.start(true, new Set(['p1']))
    expect(same.reattachedFromOtherOwner()).toBe(false)
    same.release()
    writeKeptOwner(keptOwnerFile(dir, name), { pid: CURRENT_OWNER.pid + 1, startedAt: 1 })
    const other = instance(name)
    await other.start(true, new Set(['p1']))
    expect(other.reattachedFromOtherOwner()).toBe(true)
  })

  it('lists the folders from inside the tmux server and reads the report back', async () => {
    const kept = instance(`f${names++}`)
    expect(await kept.runShell('true')).toBe(false)
    await startServer(kept)
    const home = join(root, "home #1 it's")
    mkdirSync(join(home, 'Documents'), { recursive: true })
    writeFileSync(join(home, 'Documents', 'note.txt'), 'x')
    const reads = await readFoldersInKeptShells({
      dir,
      home,
      runShell: (script) => kept.runShell(script),
    })
    expect(reads).toEqual({ Downloads: 'other', Documents: 'ok' })
  })
})
