import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixedPolicy, within } from '../sandbox/srtConfig'
import { keptHostChannel, keptShellsDir } from './keptPaths'

const home = '/home/u'
const userData = join(home, '.config', 'ostia')
const tmpRoot = join(tmpdir(), 'ostia-sbx')

function policy() {
  return fixedPolicy(
    {
      home,
      dataDirs: [userData],
      socketPath: join(home, '.local/state/ostia/control.sock'),
      runtimeReads: ['/opt/ostia'],
      tmpRoot,
    },
    { workDir: join(home, 'project'), tmpDir: join(tmpRoot, '42', 'w1') },
    { gitConfig: false },
  )
}

describe('kept shells paths', () => {
  it('KSH-C61 no socket a sandboxed shell can see is its sandbox host', () => {
    const channel = keptHostChannel(userData, 'w1')
    const { hidden, readable, writable } = policy()
    expect(within(channel, keptShellsDir(userData))).toBe(true)
    expect(hidden.some((dir) => within(keptShellsDir(userData), dir))).toBe(true)
    expect([...readable, ...writable].some((dir) => within(channel, dir))).toBe(false)
  })

  it('gives each workspace its own host channel', () => {
    expect(keptHostChannel(userData, 'w1')).not.toBe(keptHostChannel(userData, 'w2'))
    expect(keptHostChannel(userData, 'w1')).toBe(keptHostChannel(userData, 'w1'))
  })
})
