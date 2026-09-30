import { describe, expect, it } from 'vitest'
import { parseManagerArgs } from './manager'

describe('parseManagerArgs', () => {
  it('MGR-C31 reads a pane with an optional line count', () => {
    expect(parseManagerArgs(['read', 'p1', '--lines', '50'], '/w')).toEqual({
      method: 'manager.read',
      params: { paneId: 'p1', lines: 50 },
    })
    expect(() => parseManagerArgs(['read', 'p1', '--lines', '0'], '/w')).toThrow('positive')
  })

  it('MGR-C29 spawns with a cwd resolved against the caller and args after --', () => {
    expect(
      parseManagerArgs(
        ['spawn', 'claude', '--cwd', 'api', '--name', 'tests', '--', '-p', 'run --all'],
        '/home/u/src',
      ),
    ).toEqual({
      method: 'manager.spawn',
      params: { agent: 'claude', args: ['-p', 'run --all'], cwd: '/home/u/src/api', name: 'tests' },
    })
  })

  it('MGR-C30 collects text and repeated keys for input', () => {
    expect(parseManagerArgs(['input', 'p2', '--text', 'y', '--key', 'enter'], '/w')).toEqual({
      method: 'manager.input',
      params: { paneId: 'p2', text: 'y', keys: ['enter'] },
    })
  })

  it('prints usage for an unknown verb or a missing value', () => {
    expect(() => parseManagerArgs(['launch', 'x'], '/w')).toThrow('usage: pine manager')
    expect(() => parseManagerArgs(['spawn', 'claude', '--cwd'], '/w')).toThrow(
      '--cwd needs a value',
    )
  })
})
