import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { childrenOf, type ProcEntry, parseProcStat, processTree } from '../platform/procfs'
import { parseNetTcp, portsForHolders, processName, socketInode } from './procfs'

const fixture = (name: string): string =>
  readFileSync(join(__dirname, '../../../test/fixtures/ports', name), 'utf8')

describe('parseProcStat', () => {
  it('reads pid, ppid, process group and terminal foreground group', () => {
    expect(parseProcStat(fixture('stat-cat.txt'))).toEqual({
      pid: 950382,
      ppid: 950242,
      pgrp: 950242,
      tpgid: -1,
      comm: 'cat',
    })
  })

  it('keeps a command name that contains spaces and parentheses', () => {
    expect(parseProcStat(fixture('stat-parens.txt'))).toEqual({
      pid: 4242,
      ppid: 1,
      pgrp: 4242,
      tpgid: 5001,
      comm: 'tmux: server (1)',
    })
  })

  it('returns null for text that is not a stat line', () => {
    expect(parseProcStat('')).toBeNull()
    expect(parseProcStat('garbage')).toBeNull()
    expect(parseProcStat('x (sh) S a b c')).toBeNull()
  })
})

describe('parseNetTcp', () => {
  it('keeps only listening sockets with their port and inode', () => {
    expect(parseNetTcp(fixture('net-tcp.txt'))).toEqual([
      { port: 42771, inode: '3638476' },
      { port: 3000, inode: '3598505' },
      { port: 53, inode: '9424' },
    ])
  })

  it('reads IPv6 and v4-mapped addresses', () => {
    expect(parseNetTcp(fixture('net-tcp6.txt'))).toEqual([
      { port: 5173, inode: '60431' },
      { port: 3000, inode: '3598505' },
    ])
  })

  it('returns nothing for an empty table', () => {
    expect(parseNetTcp('')).toEqual([])
  })
})

describe('socketInode', () => {
  it('extracts the inode of a socket fd link and ignores other files', () => {
    expect(socketInode('socket:[3598505]')).toBe('3598505')
    expect(socketInode('/dev/pts/3')).toBeNull()
    expect(socketInode('pipe:[123]')).toBeNull()
  })
})

describe('processTree', () => {
  const procs: ProcEntry[] = [
    { pid: 10, ppid: 1, pgrp: 10, tpgid: 10, comm: 'zsh' },
    { pid: 11, ppid: 10, pgrp: 11, tpgid: 11, comm: 'pnpm' },
    { pid: 12, ppid: 11, pgrp: 11, tpgid: 11, comm: 'node' },
    { pid: 13, ppid: 12, pgrp: 11, tpgid: 11, comm: 'esbuild' },
    { pid: 20, ppid: 1, pgrp: 20, tpgid: 20, comm: 'bash' },
    { pid: 21, ppid: 20, pgrp: 21, tpgid: 21, comm: 'python3' },
  ]

  it('walks every descendant of the root, root first', () => {
    expect(processTree(10, childrenOf(procs))).toEqual([10, 11, 12, 13])
  })

  it('does not cross into another pane’s tree', () => {
    expect(processTree(20, childrenOf(procs))).toEqual([20, 21])
  })

  it('stops on a cycle instead of looping', () => {
    const cyclic: ProcEntry[] = [
      { pid: 5, ppid: 6, pgrp: 5, tpgid: 5, comm: 'a' },
      { pid: 6, ppid: 5, pgrp: 5, tpgid: 5, comm: 'b' },
    ]
    expect(processTree(5, childrenOf(cyclic))).toEqual([5, 6])
  })
})

describe('portsForHolders', () => {
  const sockets = [...parseNetTcp(fixture('net-tcp.txt')), ...parseNetTcp(fixture('net-tcp6.txt'))]

  it('names each listening port by the process holding its socket, sorted and deduplicated', () => {
    expect(
      portsForHolders(sockets, [
        { name: 'zsh', inodes: [] },
        { name: 'node', inodes: ['3598505', '60431', '999'] },
      ]),
    ).toEqual([
      { port: 3000, name: 'node' },
      { port: 5173, name: 'node' },
    ])
    expect(portsForHolders(sockets, [])).toEqual([])
  })

  it('keeps a port whose holder has no readable name, without a name', () => {
    expect(portsForHolders(sockets, [{ name: undefined, inodes: ['3598505'] }])).toEqual([
      { port: 3000 },
    ])
  })

  it('names a socket shared by a parent and its child after the first holder in the tree', () => {
    expect(
      portsForHolders(sockets, [
        { name: 'gunicorn', inodes: ['3598505'] },
        { name: 'worker', inodes: ['3598505'] },
      ]),
    ).toEqual([{ port: 3000, name: 'gunicorn' }])
  })
})

describe('processName', () => {
  it('names a process by its executable, so a Node server is node, not its thread name', () => {
    expect(processName('/usr/bin/node', 'node-MainThread')).toBe('node')
    expect(processName('/usr/lib/python3.12/bin/python3.12', 'python3')).toBe('python3.12')
  })

  it('strips the suffix of a deleted binary', () => {
    expect(processName('/usr/bin/node (deleted)', 'node-MainThread')).toBe('node')
  })

  it('falls back to comm when the link cannot be read, and to nothing without either', () => {
    expect(processName('', 'postgres')).toBe('postgres')
    expect(processName('', undefined)).toBeUndefined()
  })
})
