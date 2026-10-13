import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROMPT_CHIPS,
  DEFAULT_PROMPT_SETTINGS,
  MAX_PROMPT_CHIPS,
  isPromptChipId,
  parsePromptChips,
  parsePromptSettings,
  separatorText,
} from './promptSettings'

describe('isPromptChipId', () => {
  it('accepts core chips and "<extension>.<chip>" ids only', () => {
    expect(isPromptChipId('cwd')).toBe(true)
    expect(isPromptChipId('git.branch')).toBe(true)
    expect(isPromptChipId('my-ext.diff-stats')).toBe(true)
    expect(isPromptChipId('git')).toBe(false)
    expect(isPromptChipId('Git.Branch')).toBe(false)
    expect(isPromptChipId('git.branch.name')).toBe(false)
    expect(isPromptChipId('__proto__')).toBe(false)
    expect(isPromptChipId(3)).toBe(false)
  })
})

describe('parsePromptChips', () => {
  it('keeps the order, drops unknown ids and duplicates', () => {
    expect(parsePromptChips(['time24', 'nope', 'cwd', 'git.branch', 'cwd', 7])).toEqual([
      'time24',
      'cwd',
      'git.branch',
    ])
  })

  it('keeps an empty list and falls back to the default for a non-list', () => {
    expect(parsePromptChips([])).toEqual([])
    expect(parsePromptChips('cwd')).toEqual([...DEFAULT_PROMPT_CHIPS])
  })

  it('caps the list length', () => {
    const many = Array.from({ length: MAX_PROMPT_CHIPS + 5 }, (_, i) => `ext.chip${i}`)
    expect(parsePromptChips(many)).toHaveLength(MAX_PROMPT_CHIPS)
  })
})

describe('parsePromptSettings', () => {
  it('defaults to the shell prompt with Warp’s chip order limited to what Ostia fills', () => {
    expect(parsePromptSettings(undefined)).toEqual(DEFAULT_PROMPT_SETTINGS)
    expect(DEFAULT_PROMPT_SETTINGS).toEqual({
      style: 'shell',
      chips: ['conda', 'virtualenv', 'node', 'cwd', 'git.branch', 'git.diff-stats'],
      sameLine: false,
      separator: 'none',
    })
  })

  it('validates each field on its own', () => {
    expect(
      parsePromptSettings({ style: 'ostia', chips: ['host'], sameLine: 'yes', separator: '>' }),
    ).toEqual({ style: 'ostia', chips: ['host'], sameLine: false, separator: '>' })
    expect(parsePromptSettings({ style: 'ostia' }).style).toBe('ostia')
    expect(parsePromptSettings({ style: 'zsh', sameLine: true, separator: '#' })).toEqual({
      style: 'shell',
      chips: [...DEFAULT_PROMPT_CHIPS],
      sameLine: true,
      separator: 'none',
    })
  })

  it('never shares the default chip list with the result', () => {
    const parsed = parsePromptSettings(null)
    parsed.chips.push('host')
    expect(DEFAULT_PROMPT_SETTINGS.chips).toEqual([...DEFAULT_PROMPT_CHIPS])
  })
})

describe('separatorText', () => {
  it('renders none as nothing and the rest as themselves', () => {
    expect(separatorText('none')).toBe('')
    expect(separatorText('%')).toBe('%')
    expect(separatorText('$')).toBe('$')
    expect(separatorText('>')).toBe('>')
  })
})
