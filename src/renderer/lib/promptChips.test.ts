import { DEFAULT_PROMPT_SETTINGS } from '@shared/promptSettings'
import type { PromptContext } from '@shared/types'
import { describe, expect, it } from 'vitest'
import type { CommandBlock } from '../stores/blocksStore'
import type { ShownPaneChip } from './paneChips'
import {
  type CoreChipInputs,
  abbreviateHome,
  addChip,
  contextRequest,
  formatDuration,
  lastCommand,
  moveChip,
  needsClock,
  promptLine,
  removeChip,
  resolvePromptChips,
  spawnPromptOption,
} from './promptChips'

const shown = (patch: Partial<ShownPaneChip>): ShownPaneChip => ({
  extId: 'git',
  id: 'branch',
  paneId: 'p1',
  text: 'main',
  tone: 'neutral',
  title: 'Branch',
  extName: 'Git',
  ...patch,
})

const CONTEXT: PromptContext = {
  user: 'ada',
  host: 'box',
  home: '/home/ada',
  virtualEnv: '.venv',
  condaEnv: null,
  nodeVersion: 'v20.1.0',
  kubeContext: null,
}

const inputs = (patch: Partial<CoreChipInputs> = {}): CoreChipInputs => ({
  cwd: '/home/ada/proj',
  context: CONTEXT,
  lastCommand: null,
  now: new Date(2026, 8, 30, 14, 5),
  locale: 'en',
  ...patch,
})

const anchor = { marker: null, line: 0 } as unknown as CommandBlock['promptLine']

function block(patch: Partial<CommandBlock>): CommandBlock {
  return {
    id: 'b',
    paneId: 'p',
    promptLine: anchor,
    inputLine: null,
    outputStartLine: anchor,
    endLine: null,
    endCol: 0,
    command: 'ls',
    exitCode: null,
    cwd: null,
    startedAt: 0,
    endedAt: null,
    ...patch,
  }
}

describe('abbreviateHome', () => {
  it('shortens the home directory to ~ only on a path boundary', () => {
    expect(abbreviateHome('/home/ada', '/home/ada')).toBe('~')
    expect(abbreviateHome('/home/ada/proj', '/home/ada/')).toBe('~/proj')
    expect(abbreviateHome('/home/adam/x', '/home/ada')).toBe('/home/adam/x')
    expect(abbreviateHome('/etc', undefined)).toBe('/etc')
    expect(abbreviateHome('/etc', '/')).toBe('/etc')
  })
})

describe('formatDuration', () => {
  it('reads like Warp’s: ms, seconds, then minutes and hours', () => {
    expect(formatDuration(340)).toBe('340ms')
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(12_000)).toBe('12s')
    expect(formatDuration(125_000)).toBe('2m 5s')
    expect(formatDuration(3_725_000)).toBe('1h 2m')
    expect(formatDuration(-5)).toBe('0ms')
  })
})

describe('lastCommand', () => {
  it('takes the newest finished block and skips one still running', () => {
    const blocks = [
      block({ exitCode: 0, startedAt: 1, endedAt: 2 }),
      block({ exitCode: 2, startedAt: 10, endedAt: 40 }),
      block({ startedAt: 50 }),
    ]
    expect(lastCommand(blocks)).toEqual({ exitCode: 2, startedAt: 10, endedAt: 40 })
    expect(lastCommand([block({})])).toBeNull()
    expect(lastCommand(undefined)).toBeNull()
  })
})

describe('resolvePromptChips', () => {
  it('follows the order and hides chips without a value', () => {
    const chips = resolvePromptChips(
      ['kube', 'cwd', 'virtualenv', 'conda', 'node', 'user', 'host', 'exitCode'],
      inputs(),
      [],
    )
    expect(chips.map((c) => [c.id, c.text])).toEqual([
      ['cwd', '~/proj'],
      ['virtualenv', '.venv'],
      ['node', 'v20.1.0'],
      ['user', 'ada'],
      ['host', 'box'],
    ])
    expect(chips[0].tooltip).toBe('/home/ada/proj')
  })

  it('shows nothing from the main process before its context arrives', () => {
    const chips = resolvePromptChips(['user', 'cwd'], inputs({ context: null }), [])
    expect(chips.map((c) => c.id)).toEqual(['cwd'])
    expect(chips[0].text).toBe('/home/ada/proj')
  })

  it('colors the exit code by success and shows the last duration', () => {
    const ok = resolvePromptChips(
      ['exitCode', 'duration'],
      inputs({ lastCommand: { exitCode: 0, startedAt: 0, endedAt: 2500 } }),
      [],
    )
    expect(ok.map((c) => [c.text, c.tone])).toEqual([
      ['0', 'ok'],
      ['2.5s', 'default'],
    ])
    const failed = resolvePromptChips(
      ['exitCode'],
      inputs({ lastCommand: { exitCode: 127, startedAt: 0, endedAt: 1 } }),
      [],
    )
    expect(failed[0]).toMatchObject({ text: '127', tone: 'error' })
  })

  it('formats the date and both clocks in the UI locale', () => {
    const chips = resolvePromptChips(['time12', 'time24', 'date'], inputs(), [])
    expect(chips[0].text).toMatch(/02:05\sPM/)
    expect(chips[1].text).toBe('14:05')
    expect(chips[2].text).toContain('2026')
  })

  it('places an extension chip by its "<extension>.<chip>" id when it has a value', () => {
    const chips = resolvePromptChips(['git.branch', 'cwd', 'git.stats', 'ssh.host'], inputs(), [
      shown({ id: 'branch', text: 'main', tone: 'ok', command: 'branches' }),
      shown({ id: 'stats', text: '' }),
      shown({ extId: 'other', id: 'host', text: 'nope' }),
    ])
    expect(chips.map((c) => [c.id, c.text, c.tone])).toEqual([
      ['git.branch', 'main', 'ok'],
      ['cwd', '~/proj', 'default'],
    ])
    expect(chips[0].extension?.command).toBe('branches')
  })

  it('shows neutral and brand pane-chip tones as the default chip tone', () => {
    const chips = resolvePromptChips(['git.branch', 'git.dirty'], inputs(), [
      shown({ id: 'branch', tone: 'neutral' }),
      shown({ id: 'dirty', text: '+3', tone: 'brand' }),
    ])
    expect(chips.map((c) => c.tone)).toEqual(['default', 'default'])
  })
})

describe('contextRequest and needsClock', () => {
  it('asks main for node and kube only when those chips are in the prompt', () => {
    expect(contextRequest(['cwd'])).toEqual({ node: false, kube: false })
    expect(contextRequest(['kube', 'node'])).toEqual({ node: true, kube: true })
    expect(needsClock(['cwd', 'exitCode'])).toBe(false)
    expect(needsClock(['time24'])).toBe(true)
  })
})

describe('promptLine', () => {
  it('joins the chip texts and the separator for copying', () => {
    const chips = resolvePromptChips(['user', 'cwd'], inputs(), [])
    expect(promptLine(chips, '$')).toBe('ada ~/proj $')
    expect(promptLine(chips, 'none')).toBe('ada ~/proj')
  })
})

describe('moveChip, addChip and removeChip', () => {
  it('reorders without losing or duplicating a chip', () => {
    const order = ['a', 'b', 'c', 'd']
    expect(moveChip(order, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveChip(order, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveChip(order, 1, 99)).toEqual(['a', 'c', 'd', 'b'])
    expect(moveChip(order, 9, 0)).toEqual(order)
    expect(addChip(order, 'b')).toEqual(order)
    expect(addChip(order, 'e')).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(removeChip(order, 'c')).toEqual(['a', 'b', 'd'])
  })
})

describe('spawnPromptOption', () => {
  const settings = (style: 'shell' | 'pine', inputMode: string) => ({
    behavior: { inputMode },
    terminal: { prompt: { ...DEFAULT_PROMPT_SETTINGS, style, separator: '>' as const } },
  })

  it('asks for the plain shell prompt only for the Pine prompt in the input editor', () => {
    expect(spawnPromptOption(settings('pine', 'editor'))).toEqual({
      pinePrompt: { separator: '>', sameLine: DEFAULT_PROMPT_SETTINGS.sameLine },
    })
    expect(spawnPromptOption(settings('pine', 'terminal'))).toEqual({})
    expect(spawnPromptOption(settings('shell', 'editor'))).toEqual({})
  })
})
