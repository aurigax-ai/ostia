import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FIND_LIMIT, findLines, scoreSession } from './findSessions'
import type { SessionFile } from './sessionFiles'

const human = { kind: 'human' }

describe('handoff find', () => {
  let dir: string

  const file = (id: string, records: unknown[]): SessionFile => {
    const path = join(dir, `${id}.jsonl`)
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n'))
    return { id, path, project: 'p', modified: Date.UTC(2026, 9, 21) }
  }
  const prompt = (text: string) => ({
    type: 'user',
    cwd: '/w',
    origin: human,
    message: { content: text },
  })
  const reply = (text: string) => ({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-handoff-find-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('counts hits and matched words in human and agent messages only', () => {
    const f = file('aaaa1111', [
      { type: 'ai-title', aiTitle: 'Checkout work' },
      prompt('retry the checkout'),
      reply('checkout done'),
      { type: 'user', message: { content: 'checkout tool noise' } },
    ])
    const score = scoreSession(f, ['checkout', 'retry'])
    expect(score).toMatchObject({ hits: 2, words: 2, title: 'Checkout work', cwd: '/w' })
    expect(score.snippet).toBe('retry the checkout')
  })

  it('ranks by matched words first and lists the caller first even without hits', () => {
    const one = file('aaaa1111', [prompt('checkout only')])
    const two = file('bbbb2222', [prompt('checkout retry'), reply('retry')])
    const caller = file('cccc3333', [prompt('unrelated')])
    const lines = findLines([one, two, caller], ['checkout', 'retry'], 'cccc3333')
    expect(lines.map((l) => l.split(' ')[0])).toEqual(['cccc3333', 'bbbb2222', 'aaaa1111'])
    expect(lines[0]).toContain('(the session that handed off)')
    expect(lines[1]).toContain('2 hits, 2/2 words')
  })

  it('shows at most fifteen lines and counts the rest', () => {
    const files = Array.from({ length: FIND_LIMIT + 3 }, (_, i) =>
      file(`aaaa${String(i).padStart(4, '0')}`, [prompt('checkout')]),
    )
    const lines = findLines(files, ['checkout'], null)
    expect(lines).toHaveLength(FIND_LIMIT + 1)
    expect(lines.at(-1)).toBe('… 3 more sessions with fewer hits')
  })
})
