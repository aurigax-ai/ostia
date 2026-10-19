import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  analyze,
  benchLines,
  classifyCommand,
  codexFailed,
  collect,
  errorCode,
  estimateTokens,
  parseTranscript,
  renderReport,
  transcriptBenchLine,
  vocabularyOf,
} from '../scripts/agentTokens.mjs'
import { USAGE_TABLE } from '../src/cli/common/usageTable'

const PANE = '3f1c2d4e-1111-4222-8333-444455556666'
const SECRET = 'sk-live-do-not-leak'
const VOCAB = vocabularyOf(USAGE_TABLE, [
  "return { ok: false, error: 'hibernated' }",
  "const UNKNOWN = 'unknown-pane'",
])

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

function result(id: string, minutes: number, text: string, failed = false) {
  return {
    type: 'user',
    timestamp: at(minutes),
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: failed }],
    },
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
    expect(classifyCommand('ostia bus send abc "hi"', VOCAB)).toBe('bus.send')
    expect(classifyCommand(`cd /tmp && ostia pane read ${PANE} --lines 30`, VOCAB)).toBe(
      'pane.read',
    )
    expect(classifyCommand('ostia pane', VOCAB)).toBe('pane')
  })

  it('marks a dotted raw id and reads the Codex form of the call', () => {
    expect(classifyCommand('ostia pane.list | jq .', VOCAB)).toBe('raw:pane.list')
    expect(classifyCommand('ostia notes.private.md', VOCAB)).toBe('raw:other')
    expect(classifyCommand('ostia pane.Secret', VOCAB)).toBe('pane')
    expect(classifyCommand('echo ostia deploy hunter', VOCAB)).toBe('other')
    expect(classifyCommand('ostia pane hunter', VOCAB)).toBe('pane')
    expect(
      classifyCommand('ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" bus inbox', VOCAB),
    ).toBe('bus.inbox')
  })

  it('names a watcher script by its path words and ignores everything else', () => {
    expect(classifyCommand('bash /tmp/coord/prwatch.sh 1081', VOCAB)).toBe('watcher')
    expect(classifyCommand('git status', VOCAB)).toBeNull()
    expect(classifyCommand(undefined, VOCAB)).toBeNull()
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
  const report = analyze(parseTranscript(transcript, 'claude'), VOCAB)

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
      VOCAB,
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
  const report = analyze(parseTranscript(rollout, 'codex'), VOCAB)

  it('reads function calls, custom tool calls and their outputs by call id', () => {
    expect(report.channels['bus.wait']).toMatchObject({ calls: 1, resultChars: 'timed out'.length })
    expect(report.channels['pane.list']).toMatchObject({ calls: 1, resultChars: 'panes'.length })
  })

  it('takes turn overhead from the token usage record', () => {
    expect(report.turns.overheadTokens).toBe(1200)
  })
})

describe('collect', () => {
  const root = mkdtempSync(join(tmpdir(), 'ostia-agent-tokens-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('reads every jsonl under both folders and keeps only the asked local day', async () => {
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
    const events = await collect({
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

describe('errorCode', () => {
  it('keeps only codes that Ostia itself defines', () => {
    expect(
      errorCode(`ostia: hibernated: ${PANE} is asleep; wake it with ostia pane wake`, VOCAB.codes),
    ).toBe('hibernated')
    expect(
      errorCode('ostia: bus send failed (unknown-pane: no open pane has that id)', VOCAB.codes),
    ).toBe('unknown-pane')
    expect(errorCode('ostia pane send: unknown flag --bogus', VOCAB.codes)).toBe('unknown-flag')
    expect(errorCode('ostia bus send: missing arguments\nusage: x', VOCAB.codes)).toBe(
      'missing-arguments',
    )
    expect(errorCode('ostia pane: usage: ostia pane send <pane>', VOCAB.codes)).toBe('usage')
    expect(errorCode('usage: ostia pane <verb>   the panes you reach', VOCAB.codes)).toBe('usage')
    expect(errorCode('ostia note: deploy password is hunter', VOCAB.codes)).toBe('other')
    expect(errorCode('ostia x: secret-words: here', VOCAB.codes)).toBe('other')
    expect(errorCode(`all good ${SECRET}`, VOCAB.codes)).toBe('other')
  })

  it('reads a failed Codex call from the exit line before the output', () => {
    expect(codexFailed('Chunk ID: a\nProcess exited with code 1\nOutput:\nx')).toBe(true)
    expect(codexFailed('Exit code: 2\nOutput:\nx')).toBe(true)
    expect(codexFailed('Process exited with code 0\nOutput:\nProcess exited with code 1')).toBe(
      false,
    )
  })
})

describe('agent behaviour in transcripts', () => {
  const block = (minutes: number) => ({
    type: 'attachment',
    timestamp: at(minutes),
    attachment: {
      type: 'hook_additional_context',
      content: ['ostia bus: 1 unread message\n<ostia-bus-messages>\nhi\n</ostia-bus-messages>'],
    },
  })
  const skill = {
    type: 'user',
    isMeta: true,
    timestamp: at(0),
    message: {
      content: [
        {
          type: 'text',
          text: `Base directory for this skill: /tmp/ostia-shell-integration-1000/agents/ab/claude-plugin/skills/ostia\n\n${SECRET}`,
        },
      ],
    },
  }
  const session = lines(
    skill,
    block(1),
    bash('b1', 2, 'ostia bus inbox | jq .'),
    result('b1', 2, '[]'),
    bash('b2', 3, 'until ostia bus inbox | grep -q x; do sleep 30; done'),
    result('b2', 3, 'x'),
    bash('b3', 4, 'ostia bus send --help'),
    result('b3', 4, 'ostia bus send: missing arguments\nExit code 1', true),
    bash('b4', 5, 'ostia pane.list'),
    result('b4', 5, 'usage: ostia pane <verb>', true),
    bash('b6', 6, `ostia pane read ${PANE}`),
    result('b6', 6, 'ostia x: secret words\nostia note: deploy password is hunter'),
    bash('b7', 7, 'ostia docs'),
    result('b7', 7, 'usage: ostia docs [topic]\nostia never-takes: x'),
    bash('b5', 20, 'ostia bus inbox'),
    result('b5', 20, '[]'),
  )

  it('counts loops, sleeps, parsers, verb help, dotted ids and error codes', () => {
    const report = analyze(parseTranscript(session, 'claude'), VOCAB)
    expect(report.behaviour).toEqual({ loops: 1, sleeps: 1, parsed: 1, verbHelp: 1, raw: 1 })
    expect(report.errors).toEqual({ 'missing-arguments': 1, usage: 1 })
    expect(JSON.stringify(report)).not.toMatch(/secret|password|hunter|never-takes/)
  })

  it('counts an inbox read soon after a bus block as a re-read, in the same session only', () => {
    const report = analyze(parseTranscript(session, 'claude'), VOCAB)
    expect(report.rereads.count).toBe(2)
    const other = parseTranscript(
      lines(bash('o', 2, 'ostia bus inbox'), result('o', 2, '[]')),
      'claude',
    )
    const mixed = analyze(
      [
        ...parseTranscript(lines(block(1)), 'claude').map((e: object) => ({ ...e, session: 'a' })),
        ...other.map((e: object) => ({ ...e, session: 'b' })),
      ],
      VOCAB,
    )
    expect(mixed.rereads.count).toBe(0)
  })

  it('counts Ostia skill loads by size without keeping their text', () => {
    const report = analyze(parseTranscript(session, 'claude'), VOCAB)
    expect(report.skills.ostia.loads).toBe(1)
    expect(JSON.stringify(report)).not.toContain(SECRET)
    expect(renderReport(report)).not.toContain(SECRET)
    expect(transcriptBenchLine(report)).toMatch(/^BENCH agent-tokens transcripts \{/)
  })
})

describe('benchLines', () => {
  it('prints one BENCH line per surface with tokens, exit and the change from a saved run', () => {
    const now = { 'cli.pane.list': { chars: 350, exit: 0 }, 'skill.ostia/SKILL.md': { chars: 700 } }
    const before = { 'cli.pane.list': { chars: 700, exit: 0 }, 'docs.old': { chars: 35 } }
    expect(benchLines(now)).toEqual([
      'BENCH agent-tokens cli.pane.list {"chars":350,"tokens":100,"exit":0}',
      'BENCH agent-tokens skill.ostia/SKILL.md {"chars":700,"tokens":200}',
    ])
    expect(benchLines(now, before)).toEqual([
      'BENCH agent-tokens cli.pane.list {"chars":350,"tokens":100,"exit":0,"beforeChars":700,"deltaTokens":-100}',
      'BENCH agent-tokens docs.old {"chars":0,"tokens":0,"beforeChars":35,"deltaTokens":-10}',
      'BENCH agent-tokens skill.ostia/SKILL.md {"chars":700,"tokens":200,"beforeChars":0,"deltaTokens":200}',
    ])
  })
})

describe('estimateTokens', () => {
  it('estimates 3.5 characters to a token', () => {
    expect(estimateTokens(350)).toBe(100)
  })
})
