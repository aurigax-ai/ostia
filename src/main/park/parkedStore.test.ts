import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentResume } from '../../shared/agents/agentResume'
import { PARKED_PER_WORKSPACE_MAX } from '../../shared/park/park'
import { ParkedStore } from './parkedStore'

function fileIn(): string {
  return join(mkdtempSync(join(tmpdir(), 'parked-')), 'parked-sessions.json')
}

const claude = (id: string, extra: Partial<AgentResume> = {}): AgentResume => ({
  agent: 'claude',
  id,
  cwd: '/home/u/api',
  ...extra,
})

describe('ParkedStore', () => {
  it('keeps one record per session and updates it in place', () => {
    const store = new ParkedStore(fileIn(), () => 1)
    const first = store.park({ workspaceId: 'w1', resume: claude('s1'), title: 'export' })
    const again = store.park({
      workspaceId: 'w1',
      resume: claude('s1'),
      title: 'export',
      summary: 'stopped at the retry test',
      note: 'after lunch',
    })
    expect(first.ok && again.ok && first.record.id === again.record.id).toBe(true)
    expect(again.ok && again.updated).toBe(true)
    expect(store.list('w1')).toHaveLength(1)
    expect(store.list('w1')[0]).toMatchObject({
      summary: 'stopped at the retry test',
      note: 'after lunch',
    })
  })

  it('never stores the launch the human typed', () => {
    const file = fileIn()
    const store = new ParkedStore(file)
    const typed = { env: [{ name: 'FOO', value: 'x' }], flags: ['--model', 'x'] }
    store.park({
      workspaceId: 'w1',
      resume: { ...claude('s1'), typed } as unknown as AgentResume,
      title: 'export',
    })
    expect(readFileSync(file, 'utf8')).not.toContain('typed')
    expect(JSON.stringify(store.list('w1'))).not.toContain('FOO')
  })

  it('re-filters a record it reads from disk, dropping flags and ids it does not allow', () => {
    const file = fileIn()
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        items: [
          {
            id: 'abcdefghij',
            workspaceId: 'w1',
            resume: {
              agent: 'claude',
              id: 's1',
              cwd: '/home/u/api',
              args: ['--dangerously-skip-permissions', '--model', 'opus'],
            },
            title: 'export',
            parkedAt: 5,
          },
          {
            id: 'BAD',
            workspaceId: 'w1',
            resume: { agent: 'claude', id: 's2' },
            title: 't',
            parkedAt: 1,
          },
          {
            id: 'klmnopqrst',
            workspaceId: 'w1',
            resume: { agent: 'claude', id: '--bad' },
            title: 't',
            parkedAt: 1,
          },
        ],
      }),
    )
    const items = new ParkedStore(file).list('w1')
    expect(items).toHaveLength(1)
    expect(items[0]?.resume.args).toEqual(['--model', 'opus'])
  })

  it('writes the file 0600 and reloads it', () => {
    const file = fileIn()
    const store = new ParkedStore(file, () => 9)
    store.park({ workspaceId: 'w1', resume: claude('s1'), title: 'export', note: 'later' })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(new ParkedStore(file).list('w1')[0]).toMatchObject({
      title: 'export',
      note: 'later',
      parkedAt: 9,
    })
  })

  it('caps a workspace at the limit and still updates a parked session', () => {
    const store = new ParkedStore(fileIn())
    for (let i = 0; i < PARKED_PER_WORKSPACE_MAX; i++) {
      expect(store.park({ workspaceId: 'w1', resume: claude(`s${i}`), title: 't' }).ok).toBe(true)
    }
    expect(store.park({ workspaceId: 'w1', resume: claude('extra'), title: 't' })).toEqual({
      ok: false,
      reason: 'too-many',
    })
    expect(store.park({ workspaceId: 'w1', resume: claude('s3'), title: 't2' }).ok).toBe(true)
    expect(store.park({ workspaceId: 'w2', resume: claude('extra'), title: 't' }).ok).toBe(true)
  })

  it('lists newest first and only the workspace asked for', () => {
    let now = 0
    const store = new ParkedStore(fileIn(), () => ++now)
    store.park({ workspaceId: 'w1', resume: claude('a'), title: 'a' })
    store.park({ workspaceId: 'w2', resume: claude('b'), title: 'b' })
    store.park({ workspaceId: 'w1', resume: claude('c'), title: 'c' })
    expect(store.list('w1').map((r) => r.title)).toEqual(['c', 'a'])
  })

  it('removes a record, and settles the one of a session that started again', () => {
    const store = new ParkedStore(fileIn())
    const a = store.park({ workspaceId: 'w1', resume: claude('a'), title: 'a' })
    store.park({ workspaceId: 'w1', resume: claude('b'), title: 'b' })
    const seen: string[] = []
    store.subscribe((w) => seen.push(w))
    expect(store.settle('w1', 'claude', 'a')).toBe(1)
    expect(store.settle('w1', 'codex', 'b')).toBe(0)
    expect(store.settle('w2', 'claude', 'b')).toBe(0)
    expect(a.ok && store.remove(a.record.id)).toBe(false)
    expect(store.list('w1').map((r) => r.title)).toEqual(['b'])
    expect(seen).toEqual(['w1'])
  })

  it('collapses the note and the summary to one line and cuts them', () => {
    const store = new ParkedStore(fileIn())
    const res = store.park({
      workspaceId: 'w1',
      resume: claude('s1'),
      title: 'a\nb',
      summary: `first\nsecond ${'x'.repeat(400)}`,
      note: 'n'.repeat(400),
    })
    expect(res.ok && res.record.title).toBe('a b')
    expect(res.ok && [...(res.record.summary ?? '')].length).toBe(160)
    expect(res.ok && res.record.summary).not.toContain('\n')
    expect(res.ok && [...(res.record.note ?? '')].length).toBe(300)
  })
})
