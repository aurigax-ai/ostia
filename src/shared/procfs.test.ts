import { describe, expect, it } from 'vitest'
import { parseProcStat } from './procfs'

describe('parseProcStat', () => {
  it('parses basic proc stat', () => {
    const stat = '123 (bash) S 100 123 50 0 123 4194304 3000 0 0 0 1 0 0 0 20 0 1 0 0'
    const result = parseProcStat(stat)
    expect(result).toEqual({
      pid: 123,
      comm: 'bash',
      ppid: 100,
      pgrp: 123,
      tpgid: 123,
      ttyNr: 0,
    })
  })

  it('handles process names with spaces', () => {
    const stat = '456 (my proc) S 100 456 50 0 456 4194304 3000 0 0 0 1 0 0 0 20 0 1 0 0'
    const result = parseProcStat(stat)
    expect(result).toEqual({
      pid: 456,
      comm: 'my proc',
      ppid: 100,
      pgrp: 456,
      tpgid: 456,
      ttyNr: 0,
    })
  })

  it('handles process names with parentheses', () => {
    const stat = '789 ((my proc) x)) S 100 789 50 0 789 4194304 3000 0 0 0 1 0 0 0 20 0 1 0 0'
    const result = parseProcStat(stat)
    expect(result).toEqual({
      pid: 789,
      comm: '(my proc) x)',
      ppid: 100,
      pgrp: 789,
      tpgid: 789,
      ttyNr: 0,
    })
  })

  it('handles non-zero tty', () => {
    const stat = '111 (shell) S 100 111 50 5 111 4194304 3000 0 0 0 1 0 0 0 20 0 1 0 0'
    const result = parseProcStat(stat)
    expect(result?.ttyNr).toBe(5)
  })

  it('returns null for invalid input', () => {
    expect(parseProcStat('invalid')).toBeNull()
    expect(parseProcStat('123')).toBeNull()
    expect(parseProcStat('123 ()')).toBeNull()
  })

  it('returns null for non-integer pid', () => {
    const stat = 'abc (bash) S 100 123 50 0 123 4194304 3000 0 0 0 1 0 0 0 20 0 1 0 0'
    expect(parseProcStat(stat)).toBeNull()
  })

  it('returns null for negative pid', () => {
    const stat = '-1 (bash) S 100 123 50 0 123 4194304 3000 0 0 0 1 0 0 0 20 0 1 0 0'
    expect(parseProcStat(stat)).toBeNull()
  })

  it('returns null for non-integer fields', () => {
    const stat = '123 (bash) S abc 123 50 0 123 4194304 3000 0 0 0 1 0 0 0 20 0 1 0 0'
    expect(parseProcStat(stat)).toBeNull()
  })
})
