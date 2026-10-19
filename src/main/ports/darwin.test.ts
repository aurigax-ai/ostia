import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { childrenOf, processTree } from '../platform/procfs'
import { parseLsofListeners, parsePsTable, portsOfTree, splitPsArgs } from './darwin'

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

describe('portsOfTree', () => {
  const procs = parsePsTable(fixture('ps-table.txt'))
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const tree = processTree(500, childrenOf(procs))

  it('names each port by the basename of the process listening on it', () => {
    const listeners = new Map([
      [501, [5173, 3000]],
      [600, [2222]],
    ])
    expect(portsOfTree(tree, listeners, byPid, new Set())).toEqual([
      { port: 2222, name: 'ssh' },
      { port: 3000, name: 'node' },
      { port: 5173, name: 'node' },
    ])
  })

  it('keeps a port whose process is gone from the table, without a name', () => {
    expect(portsOfTree([...tree, 999], new Map([[999, [8000]]]), byPid, new Set())).toEqual([
      { port: 8000 },
    ])
  })

  it('leaves out ports the app itself already held', () => {
    expect(portsOfTree(tree, new Map([[501, [3000, 5173]]]), byPid, new Set([3000]))).toEqual([
      { port: 5173, name: 'node' },
    ])
  })
})

describe('splitPsArgs', () => {
  it('splits a ps args column on whitespace', () => {
    expect(splitPsArgs('  ssh -p 22 me@box\n')).toEqual(['ssh', '-p', '22', 'me@box'])
  })
})
