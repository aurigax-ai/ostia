import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FS_BINARY_MAX, readBinaryConfined } from '../fsBinary'
import { RANGE_CHUNK_MAX, readRangeConfined } from '../fsRange'
import { RANGE_STREAMS_MAX } from './viewerHost'
import { get, setup } from './viewerHostHarness'
import { parseByteRange } from './viewerRanges'

let dir: string
let outside: string
const MIB = 1024 * 1024

const confine = (path: string): string | null => (path.startsWith(`${dir}/`) ? path : null)

function realFiles() {
  return setup({
    confine,
    viewer: () => ({ dir: '/ext/office', entry: 'sheet.html' }),
    readDocument: async (path) => {
      const read = readBinaryConfined(path, confine, FS_BINARY_MAX)
      if (read.ok) return { ok: true, body: Buffer.from(read.data) }
      return { ok: false, status: read.error === 'too-large' ? 413 : 410 }
    },
    readRange: (path, start, end) => readRangeConfined(path, start, end, confine),
    statDocument: async (path) => {
      try {
        const found = statSync(path)
        return found.isFile() ? { size: found.size, modified: found.mtimeMs } : null
      } catch {
        return null
      }
    },
  })
}

function sparse(name: string, size: number): string {
  const path = join(dir, name)
  const fd = openSync(path, 'w')
  closeSync(fd)
  truncateSync(path, size)
  return path
}

async function range(path: string, header?: string) {
  const { host, sessions } = realFiles()
  const opened = host.open('w1', {
    workspaceId: 'ws',
    paneId: 'p1',
    path,
    viewType: 'office.spreadsheet',
  })
  if (!opened.ok) throw new Error('not opened')
  const session = sessions.get('ostia-viewer-office')
  const res = await get(session, 'ostia-viewer://t1/~document', {
    headers: header ? { range: header } : {},
  })
  return { res, host, session }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'viewer-range-'))
  outside = mkdtempSync(join(tmpdir(), 'viewer-range-out-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('parseByteRange', () => {
  it('reads one range and ignores anything else', () => {
    expect(parseByteRange('bytes=2-5', 10)).toEqual({ kind: 'range', start: 2, end: 5 })
    expect(parseByteRange('bytes=4-', 10)).toEqual({ kind: 'range', start: 4, end: 9 })
    expect(parseByteRange('bytes=-3', 10)).toEqual({ kind: 'range', start: 7, end: 9 })
    expect(parseByteRange('bytes=-30', 10)).toEqual({ kind: 'range', start: 0, end: 9 })
    expect(parseByteRange('bytes=2-500', 10)).toEqual({ kind: 'range', start: 2, end: 9 })
    expect(parseByteRange('bytes=10-12', 10)).toEqual({ kind: 'unsatisfiable' })
    expect(parseByteRange('bytes=-0', 10)).toEqual({ kind: 'unsatisfiable' })
    expect(parseByteRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' })
    for (const header of [
      null,
      '',
      'bytes=',
      'bytes=-',
      'bytes=5-2',
      'bytes=0-1,3-4',
      'items=0-1',
      'bytes=a-b',
    ]) {
      expect(parseByteRange(header, 10)).toEqual({ kind: 'none' })
    }
  })
})

describe('/~document ranges', () => {
  it('answers a range with 206, its Content-Range and the exact bytes', async () => {
    const path = join(dir, 'a.xlsx')
    writeFileSync(path, '0123456789')
    const { res } = await range(path, 'bytes=2-5')
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(res.headers.get('content-length')).toBe('4')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(await res.text()).toBe('2345')
    expect(await (await range(path, 'bytes=-3')).res.text()).toBe('789')
    expect(await (await range(path, 'bytes=8-')).res.text()).toBe('89')
  })

  it('answers 416 outside the file and ignores a malformed or multiple range', async () => {
    const path = join(dir, 'a.xlsx')
    writeFileSync(path, '0123456789')
    const beyond = (await range(path, 'bytes=10-20')).res
    expect(beyond.status).toBe(416)
    expect(beyond.headers.get('content-range')).toBe('bytes */10')
    for (const header of ['bytes=0-1,4-5', 'bytes=5-2', 'junk']) {
      const whole = (await range(path, header)).res
      expect(whole.status).toBe(200)
      expect(await whole.text()).toBe('0123456789')
    }
    const full = (await range(path)).res
    expect(full.headers.get('accept-ranges')).toBe('bytes')
  })

  it('serves a file over the full-read cap by range only, in chunks of at most 1 MiB', async () => {
    const path = sparse('big.xlsx', FS_BINARY_MAX + 10 * MIB)
    expect((await range(path)).res.status).toBe(413)
    const start = FS_BINARY_MAX + 2
    const { res } = await range(path, `bytes=${start}-${start + 2.5 * MIB - 1}`)
    expect(res.status).toBe(206)
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no body')
    const sizes: number[] = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      sizes.push(value.byteLength)
    }
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(2.5 * MIB)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(RANGE_CHUNK_MAX)
  })

  it('never follows a symlink swapped in after the viewer opened', async () => {
    const path = join(dir, 'a.xlsx')
    writeFileSync(path, '0123456789')
    writeFileSync(join(outside, 'secret'), 'secret-bytes')
    const { host, sessions } = realFiles()
    const opened = host.open('w1', {
      workspaceId: 'ws',
      paneId: 'p1',
      path,
      viewType: 'office.spreadsheet',
    })
    if (!opened.ok) throw new Error('not opened')
    const session = sessions.get('ostia-viewer-office')
    rmSync(path)
    symlinkSync(join(outside, 'secret'), path)
    const res = await get(session, 'ostia-viewer://t1/~document', {
      headers: { range: 'bytes=0-3' },
    })
    expect(res.status).toBe(410)
    expect(await res.text()).not.toContain('secr')
  })

  it('fails the stream of a file that shrank while it was read', async () => {
    const path = sparse('shrink.xlsx', 3 * MIB)
    const { res } = await range(path, `bytes=0-${3 * MIB - 1}`)
    truncateSync(path, 100)
    await expect(res.arrayBuffer()).rejects.toThrow()
  })

  it('refuses a directory and answers 416 for a range the file no longer holds', async () => {
    mkdirSync(join(dir, 'folder.xlsx'))
    expect((await range(join(dir, 'folder.xlsx'), 'bytes=0-1')).res.status).toBe(404)
    const path = join(dir, 'a.xlsx')
    writeFileSync(path, '0123456789')
    const { host, sessions } = realFiles()
    host.open('w1', { workspaceId: 'ws', paneId: 'p1', path, viewType: 'office.spreadsheet' })
    writeFileSync(path, '012')
    const res = await get(sessions.get('ostia-viewer-office'), 'ostia-viewer://t1/~document', {
      headers: { range: 'bytes=5-9' },
    })
    expect(res.status).toBe(416)
  })

  it('caps the concurrent range streams of one viewer and frees a slot on cancel', async () => {
    const path = sparse('streams.xlsx', 4 * MIB)
    const { host, sessions } = realFiles()
    host.open('w1', { workspaceId: 'ws', paneId: 'p1', path, viewType: 'office.spreadsheet' })
    const session = sessions.get('ostia-viewer-office')
    const open = () =>
      get(session, 'ostia-viewer://t1/~document', { headers: { range: 'bytes=0-' } })
    const held = []
    for (let i = 0; i < RANGE_STREAMS_MAX; i++) held.push(await open())
    expect(held.every((res) => res.status === 206)).toBe(true)
    expect((await open()).status).toBe(429)
    await held[0].body?.cancel()
    expect((await open()).status).toBe(206)
  })

  it('closes every range stream when the viewer ends', async () => {
    const close = vi.fn(async () => {})
    const read = vi.fn(async () => new Uint8Array(1))
    const { host, sessions } = setup({
      readRange: async () => ({ ok: true, reader: { size: 10, read, close } }),
    })
    host.open('w1', {
      workspaceId: 'ws',
      paneId: 'p1',
      path: '/home/u/report.xlsx',
      viewType: 'office.spreadsheet',
    })
    const res = await get(sessions.get('ostia-viewer-office'), 'ostia-viewer://t1/~document', {
      headers: { range: 'bytes=0-4' },
    })
    expect(res.status).toBe(206)
    host.close('w1', 'p1')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('answers a virtual source, which has no range reads, with the whole document', async () => {
    const { host, sessions } = setup()
    host.open('w1', {
      workspaceId: 'ws',
      paneId: 'p1',
      path: '/home/u/report.xlsx',
      viewType: 'office.spreadsheet',
    })
    const res = await get(sessions.get('ostia-viewer-office'), 'ostia-viewer://t1/~document', {
      headers: { range: 'bytes=1-2' },
    })
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
  })
})
