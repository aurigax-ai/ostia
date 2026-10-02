import { describe, expect, it } from 'vitest'
import { parseProcStat } from './procfs'

const TAIL = '4194304 3000 0 0 0 1 0 0 0 20 0 1 0 0'

describe('parseProcStat', () => {
  it('reads ppid from field 4, pgrp from field 5 and tpgid from field 8', () => {
    expect(parseProcStat(`123 (bash) S 100 200 300 34817 400 ${TAIL}`)).toEqual({
      pid: 123,
      comm: 'bash',
      ppid: 100,
      pgrp: 200,
      tpgid: 400,
    })
  })

  it('ends the command name at the last closing parenthesis', () => {
    expect(parseProcStat(`789 ((my proc) x)) S 100 789 50 0 -1 ${TAIL}`)).toEqual({
      pid: 789,
      comm: '(my proc) x)',
      ppid: 100,
      pgrp: 789,
      tpgid: -1,
    })
    expect(parseProcStat(`790 (a) S 1 2 3 4 5) R 100 790 50 0 6 ${TAIL}`)?.ppid).toBe(100)
  })

  it('does not look at the terminal number', () => {
    expect(parseProcStat('42 (sh) S 7 42 42 abc 5')?.tpgid).toBe(5)
  })

  it('returns null without a command name in parentheses', () => {
    expect(parseProcStat('')).toBeNull()
    expect(parseProcStat('123')).toBeNull()
    expect(parseProcStat('sh) S 7 42 42 0 5')).toBeNull()
    expect(parseProcStat('123 ()')).toBeNull()
  })

  it('returns null when the pid is not a positive integer', () => {
    expect(parseProcStat(`abc (bash) S 100 123 50 0 123 ${TAIL}`)).toBeNull()
    expect(parseProcStat(`-1 (bash) S 100 123 50 0 123 ${TAIL}`)).toBeNull()
    expect(parseProcStat(`(bash) S 100 123 50 0 123 ${TAIL}`)).toBeNull()
  })

  it('returns null when ppid, pgrp or tpgid is missing or not an integer', () => {
    expect(parseProcStat(`123 (bash) S abc 123 50 0 123 ${TAIL}`)).toBeNull()
    expect(parseProcStat('123 (bash) S 100 x 50 0 123')).toBeNull()
    expect(parseProcStat('123 (bash) S 100 123 50 0')).toBeNull()
  })
})
