import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionCaller } from '../../shared/extensions'
import { JOURNAL_DIR, Journal } from './journal'
import { Recorder, type RecorderDeps } from './recorder'

const pane = (extra: Partial<ExtensionCaller> = {}): ExtensionCaller => ({
  kind: 'pane',
  paneId: 'pane-1',
  workspaceId: 'w1',
  capabilities: [],
  ...extra,
})

const prompt = (text: string): string => JSON.stringify({ session_id: 's-1', prompt: text })

describe('Recorder', () => {
  let dir: string
  let journal: Journal
  let clock: number
  const changed = vi.fn()
  const kinds: Record<string, string> = { w1: 'terminal', s1: 'scratch', b1: 'terminal' }

  const recorder = (extra: Partial<RecorderDeps> = {}): Recorder =>
    new Recorder({
      journal,
      now: () => clock++,
      redact: async (texts) => texts.map((t) => t.replaceAll('hunter2', '[redacted]')),
      workspaceKind: async (id) => kinds[id] ?? null,
      changed,
      ...extra,
    })
  const file = (workspaceId: string): string => join(dir, JOURNAL_DIR, `${workspaceId}.jsonl`)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-activity-recorder-'))
    journal = new Journal({ dir, now: () => clock })
    clock = 5000
    changed.mockReset()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('stores the redacted text of each event in the order the hooks arrived', async () => {
    const slowFirst = vi
      .fn<RecorderDeps['redact']>()
      .mockImplementationOnce(async (texts) => {
        await new Promise((r) => setTimeout(r, 30))
        return texts.map((t) => t.replaceAll('hunter2', '[redacted]'))
      })
      .mockImplementation(async (texts) => texts)
    const rec = recorder({ redact: slowFirst })
    expect(rec.accept(['claude', 'UserPromptSubmit'], prompt('log in with hunter2'), pane())).toBe(
      true,
    )
    expect(
      rec.accept(
        ['claude', 'PreToolUse'],
        JSON.stringify({ session_id: 's-1', tool_name: 'Bash', tool_input: { command: 'ls' } }),
        pane(),
      ),
    ).toBe(true)
    expect(
      rec.accept(
        ['claude', 'Stop'],
        JSON.stringify({ session_id: 's-1', last_assistant_message: 'Listed the folder.' }),
        pane(),
      ),
    ).toBe(true)
    await rec.settled()
    expect(journal.events('w1').map((e) => [e.t, e.kind, e.text])).toEqual([
      [5000, 'prompt', 'log in with [redacted]'],
      [5001, 'tool', 'ls'],
      [5002, 'stop', 'Listed the folder.'],
    ])
    expect(readFileSync(file('w1'), 'utf8')).not.toContain('hunter2')
    expect(changed).toHaveBeenCalledTimes(3)
  })

  it('keeps the event without its text when the scan fails', async () => {
    const rec = recorder({ redact: async () => null })
    rec.accept(['claude', 'UserPromptSubmit'], prompt('log in with hunter2'), pane())
    const throwing = recorder({
      redact: async () => {
        throw new Error('scan died')
      },
    })
    throwing.accept(['codex', 'UserPromptSubmit'], prompt('log in with hunter2'), pane())
    await rec.settled()
    await throwing.settled()
    expect(journal.events('w1').map((e) => [e.agent, e.kind, e.text])).toEqual([
      ['claude', 'prompt', undefined],
      ['codex', 'prompt', undefined],
    ])
    expect(readFileSync(file('w1'), 'utf8')).not.toContain('hunter2')
  })

  it('leaves no file for a scratch workspace, a sandboxed caller or a workspace it cannot name', async () => {
    const rec = recorder()
    rec.accept(['claude', 'UserPromptSubmit'], prompt('scratch work'), pane({ workspaceId: 's1' }))
    rec.accept(
      ['claude', 'UserPromptSubmit'],
      prompt('boxed work'),
      pane({ workspaceId: 'b1', sandboxed: true }),
    )
    rec.accept(
      ['claude', 'UserPromptSubmit'],
      prompt('unknown work'),
      pane({ workspaceId: 'gone' }),
    )
    await rec.settled()
    for (const id of ['s1', 'b1', 'gone']) {
      expect(journal.events(id)).toHaveLength(1)
      expect(journal.keepsOnDisk(id)).toBe(false)
      expect(existsSync(file(id))).toBe(false)
    }
    expect(existsSync(join(dir, JOURNAL_DIR))).toBe(false)
  })

  it('ignores callers that are not a pane, events it does not record and unknown agents', async () => {
    const rec = recorder()
    expect(
      rec.accept(['claude', 'UserPromptSubmit'], prompt('x'), { kind: 'user', capabilities: [] }),
    ).toBe(false)
    expect(rec.accept(['claude', 'SessionStart'], '{}', pane())).toBe(false)
    expect(rec.accept(['claude', 'PostToolUse'], '{"tool_name":"Bash"}', pane())).toBe(false)
    expect(rec.accept(['gemini', 'Stop'], '{}', pane())).toBe(false)
    expect(rec.accept(['claude', 'Stop'], 'not json', pane())).toBe(false)
    expect(rec.accept([], '{}', pane())).toBe(false)
    await rec.settled()
    expect(journal.workspaceIds()).toEqual([])
    expect(changed).not.toHaveBeenCalled()
  })
})
