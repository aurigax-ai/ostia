import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BROWSE_CHUNK_METHOD,
  BROWSE_ENTRIES_METHOD,
  BROWSE_LIMITS,
  BROWSE_LIST_METHOD,
  BROWSE_READ_AT_METHOD,
  BROWSE_READ_METHOD,
  type BrowseLimits,
  browseCallBudget,
  browseReadBudget,
} from '@aurigax-ai/ostia-extension-sdk/contract/fileBrowse'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { type BrowseHarness, browseHarness } from '../../../test/browseHarness'
import { zipOf } from '../../../test/fixtures/archives/archives'
import { zip } from '../../extensions/archives/zip'
import { closeFd, openRegular } from '../files/archives/archiveFile'
import type { BrowseTarget } from '../files/archives/browseProviders'

const MIB = 1024 * 1024
const CANDIDATE = {
  extId: 'archives',
  builtin: true,
  kind: { id: 'archives.zip', selector: [{ filenamePattern: '*.zip' }] },
}
const FAST = { listGraceMs: 30, readMs: 60, killGraceMs: 30 }

let dir: string
let harness: BrowseHarness | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ext-browse-'))
})

afterEach(() => {
  harness?.dispose()
  harness = null
  rmSync(dir, { recursive: true, force: true })
})

async function open(
  bytes: Uint8Array | number,
): Promise<{ target: BrowseTarget; close: () => void }> {
  const path = join(dir, 'a.zip')
  writeFileSync(path, typeof bytes === 'number' ? Buffer.alloc(bytes, 1) : bytes)
  const opened = await openRegular(path)
  if (!opened) throw new Error('not opened')
  return {
    target: { extId: 'archives', kind: 'archives.zip', fd: opened.fd, size: opened.stat.size },
    close: () => closeFd(opened.fd),
  }
}

function limits(extra: Partial<BrowseLimits> = {}): BrowseLimits {
  return { ...BROWSE_LIMITS, ...extra }
}

const idle = new AbortController().signal

function raw(
  list: (extConn: MessageConnection, ticket: string) => Promise<unknown>,
  read?: (extConn: MessageConnection, ticket: string) => Promise<unknown>,
) {
  return (extConn: MessageConnection): void => {
    extConn.onRequest(BROWSE_LIST_METHOD, (params: { ticket: string }) =>
      list(extConn, params.ticket),
    )
    extConn.onRequest(BROWSE_READ_METHOD, (params: { ticket: string }) =>
      read ? read(extConn, params.ticket) : { ok: true },
    )
  }
}

const entry = (name: string) => ({ name, dir: false, size: 1, encrypted: false, link: null })

describe('ExtensionBrowse tickets and readAt', () => {
  it('serves aligned blocks of the file it opened and nothing else', async () => {
    const bytes = Buffer.alloc(MIB + 10, 7)
    const { target, close } = await open(bytes)
    const answers: unknown[] = []
    harness = browseHarness({
      candidates: [CANDIDATE],
      raw: raw(async (extConn, ticket) => {
        for (const [offset, length] of [
          [0, MIB],
          [MIB, 10],
          [1, 10],
          [0, 100],
          [MIB, 11],
          [0, 0],
          [0, MIB + 1],
          [-1, 5],
        ]) {
          answers.push(await extConn.sendRequest(BROWSE_READ_AT_METHOD, { ticket, offset, length }))
        }
        return { ok: true, complete: true }
      }),
    })
    await harness.browse.list(target, limits(), idle)
    close()
    expect(answers.map((a) => (a as { ok: boolean; error?: string }).error ?? 'data')).toEqual([
      'data',
      'data',
      'unaligned',
      'unaligned',
      'out-of-range',
      'invalid',
      'invalid',
      'invalid',
    ])
  })

  it('answers unknown-ticket to a late call, a made-up ticket and another extension', async () => {
    const { target, close } = await open(20)
    let seen = ''
    harness = browseHarness({
      candidates: [CANDIDATE],
      raw: raw(async (_extConn, ticket) => {
        seen = ticket
        return { ok: true, complete: true }
      }),
    })
    await harness.browse.list(target, limits(), idle)
    const late = await harness.extConn.sendRequest(BROWSE_READ_AT_METHOD, {
      ticket: seen,
      offset: 0,
      length: 20,
    })
    const forged = await harness.extConn.sendRequest(BROWSE_READ_AT_METHOD, {
      ticket: 'a'.repeat(32),
      offset: 0,
      length: 20,
    })
    close()
    expect(late).toEqual({ ok: false, error: 'unknown-ticket' })
    expect(forged).toEqual({ ok: false, error: 'unknown-ticket' })
    expect(seen).toMatch(/^[0-9a-f]{32}$/)
  })

  it('refuses a call past the byte or call budget and cancels the request', async () => {
    const { target, close } = await open(MIB)
    const answers: string[] = []
    harness = browseHarness({
      candidates: [CANDIDATE],
      raw: raw(async (extConn, ticket) => {
        for (let i = 0; i < browseCallBudget(MIB) + 5; i++) {
          const reply = (await extConn.sendRequest(BROWSE_READ_AT_METHOD, {
            ticket,
            offset: 0,
            length: MIB,
          })) as { ok: boolean; error?: string }
          answers.push(reply.ok ? 'ok' : (reply.error ?? '?'))
          if (!reply.ok) break
        }
        return { ok: true, complete: true }
      }),
    })
    const listing = await harness.browse.list(target, limits(), idle)
    close()
    expect(answers.at(-1)).toBe('over-budget')
    expect(answers.filter((a) => a === 'ok').length).toBe(
      Math.min(browseCallBudget(MIB), Math.floor(browseReadBudget(MIB) / MIB)),
    )
    expect(listing).toEqual({ ok: false, error: 'over-budget' })
  })
})

describe('ExtensionBrowse pages', () => {
  async function listWith(pages: unknown[][], extra: Partial<BrowseLimits> = {}) {
    const { target, close } = await open(10)
    const replies: unknown[] = []
    harness = browseHarness({
      candidates: [CANDIDATE],
      raw: raw(async (extConn, ticket) => {
        for (const entries of pages) {
          const reply = (await extConn.sendRequest(BROWSE_ENTRIES_METHOD, { ticket, entries })) as {
            more?: boolean
          }
          replies.push(reply)
          if (reply.more === false) break
        }
        return { ok: true, complete: true }
      }),
    })
    const listing = await harness.browse.list(target, limits(extra), idle)
    close()
    return { listing, replies }
  }

  it('numbers entries in the order they arrive across pages', async () => {
    const { listing } = await listWith([[entry('a'), entry('b')], [entry('c')]])
    expect(listing).toEqual({
      ok: true,
      entries: [
        { ...entry('a'), index: 0 },
        { ...entry('b'), index: 1 },
        { ...entry('c'), index: 2 },
      ],
    })
  })

  it('stops the provider once the listing is over the entry limit and keeps what it has', async () => {
    const { listing, replies } = await listWith(
      [[entry('a'), entry('b'), entry('c')], [entry('d')]],
      { entries: 2 },
    )
    expect(replies).toEqual([{ ok: true, more: false }])
    expect(listing.ok && listing.entries.map((e) => e.name)).toEqual(['a', 'b', 'c'])
  })

  it('stops at the total name bytes', async () => {
    const long = 'x'.repeat(4000)
    const page = Array.from({ length: 450 }, () => entry(long))
    const { listing } = await listWith([page, page, page, page, page, page])
    expect(listing.ok && listing.entries.length).toBeLessThan(2100)
  })

  it('fails the whole listing for one malformed entry, a long name or a long link', async () => {
    const bad: unknown[] = [
      { name: 1, dir: false, size: 1, encrypted: false, link: null },
      { ...entry('a'), size: -1 },
      { ...entry('a'), dir: 'no' },
      entry('n'.repeat(4097)),
      { ...entry('a'), link: 'l'.repeat(BROWSE_LIMITS.linkTargetBytes + 1) },
    ]
    for (const item of bad) {
      const { listing } = await listWith([[entry('ok'), item]])
      expect(listing).toEqual({ ok: false, error: 'invalid' })
    }
  })
})

describe('ExtensionBrowse entry reads', () => {
  async function readWith(chunks: Buffer[], max: number, result: unknown = { ok: true }) {
    const { target, close } = await open(10)
    harness = browseHarness({
      candidates: [CANDIDATE],
      raw: raw(
        async () => ({ ok: true, complete: true }),
        async (extConn, ticket) => {
          for (const chunk of chunks) {
            const reply = (await extConn.sendRequest(BROWSE_CHUNK_METHOD, {
              ticket,
              data: chunk.toString('base64'),
            })) as { more: boolean }
            if (!reply.more) break
          }
          return result
        },
      ),
    })
    const read = await harness.browse.read(target, 0, max, limits(), idle)
    close()
    return read
  }

  it('joins the chunks of an entry', async () => {
    const read = await readWith([Buffer.from('ab'), Buffer.from('cd')], 10)
    expect(read.ok && read.data.toString()).toBe('abcd')
  })

  it('refuses an entry over the cap as too large whatever the provider says', async () => {
    const read = await readWith([Buffer.alloc(6), Buffer.alloc(6)], 10)
    expect(read).toEqual({ ok: false, problem: 'too-large' })
  })

  it('maps provider errors onto the reasons the Files tree knows', async () => {
    for (const [error, problem] of [
      ['encrypted', 'encrypted'],
      ['link', 'link'],
      ['gone', 'gone'],
      ['limit', 'unzip-limit'],
      ['corrupt', 'unreadable'],
      ['failed', 'unreadable'],
    ]) {
      expect(await readWith([], 10, { ok: false, error })).toEqual({ ok: false, problem })
    }
  })
})

describe('ExtensionBrowse deadlines, cancel and recycle', () => {
  it('times a stuck listing out, cancels it and recycles the process after the grace', async () => {
    const { target, close } = await open(10)
    let cancelled = false
    harness = browseHarness({
      candidates: [CANDIDATE],
      timing: FAST,
      raw: (extConn) => {
        extConn.onRequest(BROWSE_LIST_METHOD, (_params: unknown, token) => {
          token.onCancellationRequested(() => {
            cancelled = true
          })
          return new Promise(() => {})
        })
      },
    })
    const listing = await harness.browse.list(target, limits({ scanMs: 20 }), idle)
    close()
    expect(listing).toEqual({ ok: false, error: 'timeout' })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(cancelled).toBe(true)
    expect(harness.recycled).toEqual(['archives'])
  })

  it('does not recycle a process whose request settled after the cancel', async () => {
    const { target, close } = await open(10)
    harness = browseHarness({
      candidates: [CANDIDATE],
      timing: FAST,
      raw: (extConn) => {
        extConn.onRequest(BROWSE_LIST_METHOD, (_params: unknown, token) => {
          return new Promise((resolve) =>
            token.onCancellationRequested(() => resolve({ ok: false, error: 'cancelled' })),
          )
        })
      },
    })
    await harness.browse.list(target, limits({ scanMs: 20 }), idle)
    close()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(harness.recycled).toEqual([])
  })

  it('cancels a request the caller no longer wants', async () => {
    const { target, close } = await open(10)
    const abort = new AbortController()
    let cancelled = false
    harness = browseHarness({
      candidates: [CANDIDATE],
      raw: (extConn) => {
        extConn.onRequest(BROWSE_LIST_METHOD, (_params: unknown, token) => {
          return new Promise((resolve) =>
            token.onCancellationRequested(() => {
              cancelled = true
              resolve({ ok: false, error: 'cancelled' })
            }),
          )
        })
      },
    })
    const pending = harness.browse.list(target, limits(), abort.signal)
    await new Promise((resolve) => setTimeout(resolve, 20))
    abort.abort()
    expect(await pending).toEqual({ ok: false, error: 'cancelled' })
    close()
    expect(cancelled).toBe(true)
  })

  it('runs four requests at once per extension, queues sixteen and answers busy past that', async () => {
    const { target, close } = await open(10)
    const release: Array<() => void> = []
    let running = 0
    let peak = 0
    harness = browseHarness({
      candidates: [CANDIDATE],
      raw: raw(async () => {
        running += 1
        peak = Math.max(peak, running)
        await new Promise<void>((resolve) => release.push(resolve))
        running -= 1
        return { ok: true, complete: true }
      }),
    })
    const all = Array.from({ length: 22 }, () => harness?.browse.list(target, limits(), idle))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(peak).toBe(4)
    const busy = (await Promise.all(all.slice(20))) as Array<{ ok: boolean; error?: string }>
    expect(busy).toEqual([
      { ok: false, error: 'busy' },
      { ok: false, error: 'busy' },
    ])
    while (release.length > 0 || running > 0) {
      release.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    await Promise.all(all)
    close()
    expect(peak).toBe(4)
  })

  it('names the one kind that serves a file, and none for a file nobody serves', () => {
    harness = browseHarness({ candidates: [CANDIDATE], raw: raw(async () => ({ ok: true })) })
    expect(harness.browse.kindFor('/w/a.zip')).toEqual({ extId: 'archives', kind: 'archives.zip' })
    expect(harness.browse.kindFor('/w/a.rar')).toBeNull()
  })
})

describe('ExtensionBrowse with the real zip provider', () => {
  it('lists a 20,000-entry zip within the call budget of its size', async () => {
    const items = Array.from({ length: 20_000 }, (_unused, i) => ({
      name: `dir/f${i}.txt`,
      data: 'x',
    }))
    const bytes = zipOf(items)
    const { target, close } = await open(bytes)
    harness = browseHarness({ providers: { 'archives.zip': zip }, candidates: [CANDIDATE] })
    const listing = await harness.browse.list(target, limits(), idle)
    close()
    expect(listing.ok && listing.entries.length).toBe(20_000)
    expect(harness.calls.readAt).toBeLessThanOrEqual(browseCallBudget(bytes.length))
    expect(harness.calls.entries).toBeGreaterThanOrEqual(40)
  })
})
