import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  analyze,
  classifyCommand,
  collect,
  estimateTokens,
  parseTranscript,
  renderReport,
} from '../scripts/coordinationTokens.mjs'

const PANE = '3f1c2d4e-1111-4222-8333-444455556666'
const SECRET = 'sk-live-do-not-leak'

function at(minutes: number): string {
  return new Date(2026, 9, 18, 10, minutes, 0).toISOString()
}

function lines(...records: object[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

function bash(id: string, minutes: number, command: string) {
  return {
    type: 'assistant',
    timestamp: at(minutes),
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  }
}

function result(id: string, minutes: number, text: string) {
  return {
    type: 'user',
    timestamp: at(minutes),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  }
}

function usage(minutes: number, input: number, cacheRead: number) {
  return {
    type: 'assistant',
    timestamp: at(minutes),
    message: {
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: input, cache_read_input_tokens: cacheRead },
    },
  }
}

describe('classifyCommand', () => {
  it('names the ostia noun and verb, also inside a compound command', () => {
    expect(classifyCommand('ostia bus send abc "hi"')).toBe('bus.send')
    expect(classifyCommand(`cd /tmp && ostia pane read ${PANE} --lines 30`)).toBe('pane.read')
    expect(classifyCommand('ostia pane')).toBe('pane')
  })

  it('names a watcher script by its path words and ignores everything else', () => {
    expect(classifyCommand('bash /tmp/coord/prwatch.sh 1081')).toBe('watcher')
    expect(classifyCommand('git status')).toBeNull()
    expect(classifyCommand(undefined)).toBeNull()
  })
})

describe('analyze Claude transcripts', () => {
  const transcript = lines(
    bash('c1', 0, 'ostia bus send w-3 "please review"'),
    result('c1', 0, '{"ok":true}'),
    bash('c2', 1, `ostia pane read ${PANE} --lines 30`),
    result('c2', 1, `screen one ${SECRET}`),
    bash('c3', 3, `ostia pane read ${PANE} --lines 30`),
    result('c3', 3, `screen one ${SECRET}`),
    bash('c4', 5, `ostia pane read ${PANE} --lines 30`),
    result('c4', 5, 'screen two'),
    bash('c5', 6, 'bash prwatch.sh 7'),
    result('c5', 6, 'checks pending'),
    {
      type: 'user',
      timestamp: at(7),
      message: {
        content: [
          {
            type: 'text',
            text: 'Ostia bus: 1 unread message\n<ostia-bus-messages>\nx\n</ostia-bus-messages>',
          },
        ],
      },
    },
    usage(8, 50, 9000),
    {
      type: 'user',
      timestamp: at(9),
      message: { content: [{ type: 'text', text: 'a human prompt' }] },
    },
    usage(10, 40, 7000),
    bash('c6', 11, 'gh pr merge 7 --merge'),
  )
  const report = analyze(parseTranscript(transcript, 'claude'))

  it('sums calls, written and read characters per channel', () => {
    expect(report.channels['bus.send']).toMatchObject({
      calls: 1,
      commandChars: 'ostia bus send w-3 "please review"'.length,
      resultChars: '{"ok":true}'.length,
    })
    expect(report.channels['pane.read'].calls).toBe(3)
    expect(report.channels.watcher.calls).toBe(1)
  })

  it('counts a pane read repeated within ten minutes with an unchanged screen', () => {
    expect(report.repeats.count).toBe(1)
    expect(report.repeats.resultChars).toBe(`screen one ${SECRET}`.length)
  })

  it('counts bus context blocks and charges only coordination turns for their overhead', () => {
    expect(report.hooks.busBlocks).toBe(1)
    expect(report.turns).toMatchObject({
      total: 2,
      coordination: 1,
      overheadTokens: 50 + 9000 + 40 + 7000,
      coordinationOverheadTokens: 50 + 9000,
    })
  })

  it('divides by finished tasks, where a task is a merged PR', () => {
    expect(report.tasks).toBe(1)
    expect(report.perTask.coordinationTokens).toBe(report.coordinationTokens)
    expect(report.perTask.paneReads).toBe(3)
    expect(report.perTask.pollingCalls).toBe(1)
  })

  it('reports counts and sizes only, never any text', () => {
    expect(JSON.stringify(report)).not.toContain(SECRET)
    expect(renderReport(report)).not.toContain(SECRET)
    expect(renderReport(report)).toContain('pane.read')
  })

  it('has no per-task numbers to divide by when nothing merged, and divides by one', () => {
    const none = analyze(
      parseTranscript(lines(bash('a', 0, 'ostia pane list'), result('a', 0, 'x')), 'claude'),
    )
    expect(none.tasks).toBe(0)
    expect(none.perTask.coordinationTokens).toBe(none.coordinationTokens)
  })

  it('buckets calls and tokens per local hour', () => {
    const hour = Object.keys(report.perHour)[0]
    expect(Object.keys(report.perHour)).toHaveLength(1)
    expect(report.perHour[hour].calls).toBe(5)
    expect(report.perHour[hour].tokens).toBeGreaterThan(0)
  })
})

describe('parseTranscript for Codex rollouts', () => {
  const rollout = lines(
    {
      timestamp: at(0),
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'k1',
        arguments: JSON.stringify({ cmd: 'ostia bus wait --timeout 30' }),
      },
    },
    {
      timestamp: at(1),
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'k1', output: 'timed out' },
    },
    {
      timestamp: at(2),
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'k2', name: 'shell', input: 'ostia pane list' },
    },
    {
      timestamp: at(2),
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'k2',
        output: [{ type: 'text', text: 'panes' }],
      },
    },
    { timestamp: at(3), type: 'token_usage_record', payload: { usage: { input_tokens: 1200 } } },
  )
  const report = analyze(parseTranscript(rollout, 'codex'))

  it('reads function calls, custom tool calls and their outputs by call id', () => {
    expect(report.channels['bus.wait']).toMatchObject({ calls: 1, resultChars: 'timed out'.length })
    expect(report.channels['pane.list']).toMatchObject({ calls: 1, resultChars: 'panes'.length })
  })

  it('takes turn overhead from the token usage record', () => {
    expect(report.turns.overheadTokens).toBe(1200)
  })
})

describe('collect', () => {
  const root = mkdtempSync(join(tmpdir(), 'ostia-coordination-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('reads every jsonl under both folders and keeps only the asked local day', () => {
    const claude = join(root, 'claude', 'proj')
    const codex = join(root, 'codex', '2026', '10', '18')
    mkdirSync(claude, { recursive: true })
    mkdirSync(codex, { recursive: true })
    const old = {
      ...bash('o1', 0, 'ostia pane list'),
      timestamp: new Date(2026, 9, 1, 9).toISOString(),
    }
    writeFileSync(join(claude, 's.jsonl'), lines(bash('n1', 0, 'ostia pane list'), old))
    writeFileSync(
      join(codex, 'rollout.jsonl'),
      lines({
        timestamp: at(0),
        type: 'response_item',
        payload: { type: 'function_call', call_id: 'z', arguments: '{"cmd":"ostia bus inbox"}' },
      }),
    )
    const events = collect({
      day: '2026-10-18',
      claudeDir: join(root, 'claude'),
      codexDir: join(root, 'codex'),
    })
    expect(events.map((event: { command: string }) => event.command).sort()).toEqual([
      'ostia bus inbox',
      'ostia pane list',
    ])
  })
})

describe('estimateTokens', () => {
  it('estimates 3.5 characters to a token', () => {
    expect(estimateTokens(350)).toBe(100)
  })
})
