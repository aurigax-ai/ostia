import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLsofListeners, parsePsTable, splitPsArgs } from './darwin'
import { childrenOf, processTree } from './procfs'

const fixture = (name: string): string =>
  readFileSync(join(__dirname, '../../../test/fixtures/ports', name), 'utf8')

describe('parsePsTable', () => {
  it('reads pid, ppid, process group, foreground group and the command basename', () => {
    const procs = parsePsTable(fixture('ps-table.txt'))
    expect(procs).toContainEqual({ pid: 600, ppid: 500, pgrp: 600, tpgid: 600, comm: 'ssh' })
    expect(procs).toContainEqual({ pid: 700, ppid: 1, pgrp: 700, tpgid: -1, comm: 'Electron' })
    expect(processTree(500, childrenOf(procs))).toEqual([500, 501, 600])
  })
})

describe('parseLsofListeners', () => {
  it('groups listening ports by pid and skips unparsable names', () => {
    expect(parseLsofListeners(fixture('lsof-listen.txt'))).toEqual(
      new Map([
        [501, [3000]],
        [777, [5173]],
      ]),
    )
  })
})

describe('splitPsArgs', () => {
  it('splits a ps args column on whitespace', () => {
    expect(splitPsArgs('  ssh -p 22 me@box\n')).toEqual(['ssh', '-p', '22', 'me@box'])
  })
})
