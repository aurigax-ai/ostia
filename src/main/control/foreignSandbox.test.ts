import { describe, expect, it } from 'vitest'
import {
  escapesSandbox,
  escapesSandboxCommand,
  type Peer,
  parseSeccomp,
  parseStartTime,
  peerOf,
  readPeer,
  sandboxedByKernel,
} from './foreignSandbox'

const stat = (start: string) =>
  `4242 (we ird) name) S 1 4242 4242 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 ${start} 1 1 0`
const status = (seccomp: number) => `Name:\tx\nSeccomp:\t${seccomp}\nSeccomp_filters:\t1\n`

function fakeProc(files: Record<string, string>) {
  return { read: (path: string) => files[path] ?? null }
}

describe('foreign sandbox signals', () => {
  it('reads the seccomp mode and the start time', () => {
    expect(parseSeccomp(status(2))).toBe(2)
    expect(parseSeccomp('Name:\tx\n')).toBeNull()
    expect(parseStartTime(stat('987654'))).toBe('987654')
    expect(parseStartTime('garbage')).toBeNull()
  })

  it('reads a peer only when the start time is stable and readable', () => {
    const proc = fakeProc({ '/proc/10/stat': stat('55'), '/proc/10/status': status(2) })
    expect(readPeer(10, proc)).toEqual({ pid: 10, startTime: '55', seccomp: 2 })
    expect(readPeer(11, proc)).toBeNull()
    expect(readPeer(10, fakeProc({ '/proc/10/stat': stat('55') }))).toBeNull()
  })

  it('finds the peer through the socket pid reader', async () => {
    const proc = fakeProc({ '/proc/10/stat': stat('55'), '/proc/10/status': status(0) })
    const socket = {} as never
    expect(await peerOf(socket, async () => null)).toBeNull()
    expect(await peerOf(socket, async () => 999_999_999)).toBeNull()
    expect(readPeer(10, proc)?.seccomp).toBe(0)
  })

  describe('sandboxedByKernel', () => {
    const caller = (seccomp: number): Peer => ({ pid: 10, startTime: '55', seccomp })
    const world = (callerSeccomp: number, shellSeccomp: number, start = '55') =>
      fakeProc({
        '/proc/10/stat': stat(start),
        '/proc/10/status': status(callerSeccomp),
        '/proc/20/status': status(shellSeccomp),
      })

    it('refuses a filtered caller whose pane shell has no filter', () => {
      expect(sandboxedByKernel(caller(2), 20, world(2, 0))).toBe(true)
    })

    it('allows a caller without a filter', () => {
      expect(sandboxedByKernel(caller(0), 20, world(0, 0))).toBe(false)
    })

    it('allows a filtered caller when its pane shell has the filter too', () => {
      expect(sandboxedByKernel(caller(2), 20, world(2, 2))).toBe(false)
    })

    it('allows when the peer, the shell or the shell pid is unknown', () => {
      expect(sandboxedByKernel(null, 20, world(2, 0))).toBe(false)
      expect(sandboxedByKernel(caller(2), undefined, world(2, 0))).toBe(false)
      expect(sandboxedByKernel(caller(2), 21, world(2, 0))).toBe(false)
    })

    it('refuses when the pid now belongs to another process', () => {
      expect(sandboxedByKernel(caller(2), 20, world(0, 2, '99'))).toBe(true)
    })

    it('keeps the verdict of a caller that has exited', () => {
      const gone = fakeProc({ '/proc/20/status': status(0) })
      expect(sandboxedByKernel(caller(2), 20, gone)).toBe(true)
    })
  })

  describe('escaping verbs', () => {
    it('always refuses process and agent starts and resume records', () => {
      for (const method of [
        'process.run',
        'process.kill',
        'process.restart',
        'agent.run',
        'pane.setResume',
      ]) {
        expect(escapesSandbox(method, {}, 'pOwn')).toBe(true)
      }
    })

    it('refuses pane verbs aimed at another pane', () => {
      expect(escapesSandbox('pane.input', { pane: 'pOther', text: 'x' }, 'pOwn')).toBe(true)
      expect(escapesSandbox('pane.close', { panes: ['pOwn', 'pOther'] }, 'pOwn')).toBe(true)
      expect(escapesSandbox('pane.wake', { panes: ['pOther'] }, 'pOwn')).toBe(true)
      expect(escapesSandbox('pane.moveTo', { panes: 'pOther' }, 'pOwn')).toBe(true)
    })

    it('allows pane verbs on the own pane and every other verb', () => {
      expect(escapesSandbox('pane.input', { pane: 'pOwn' }, 'pOwn')).toBe(false)
      expect(escapesSandbox('pane.close', {}, 'pOwn')).toBe(false)
      expect(escapesSandbox('bus.send', { to: 'x' }, 'pOwn')).toBe(false)
      expect(escapesSandbox('process.list', {}, 'pOwn')).toBe(false)
    })

    it('judges a command by its id and target pane', () => {
      expect(escapesSandboxCommand('pane.close', 'pOther', 'pOwn')).toBe(true)
      expect(escapesSandboxCommand('pane.close', 'pOwn', 'pOwn')).toBe(false)
      expect(escapesSandboxCommand('pane.splitRight', 'pOther', 'pOwn')).toBe(false)
    })
  })
})
