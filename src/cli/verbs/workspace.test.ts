import { describe, expect, it } from 'vitest'
import {
  parseGroupColorArgs,
  parseGroupDeleteArgs,
  parseGroupRenameArgs,
  parseWorkspaceGroupArgs,
  parseWorkspaceRenameArgs,
} from './workspace'

describe('parseWorkspaceRenameArgs', () => {
  it('renames your own workspace, or the one named with --workspace', () => {
    expect(parseWorkspaceRenameArgs(['research', 'line'])).toEqual({ name: 'research line' })
    expect(parseWorkspaceRenameArgs(['--workspace', 'ws2', 'api'])).toEqual({
      workspace: 'ws2',
      name: 'api',
    })
    expect(parseWorkspaceRenameArgs(['--clear'])).toEqual({ name: '' })
  })

  it('refuses no name and a name with --clear', () => {
    expect(() => parseWorkspaceRenameArgs([])).toThrow('usage: ostia workspace rename')
    expect(() => parseWorkspaceRenameArgs(['--clear', 'x'])).toThrow(
      'usage: ostia workspace rename',
    )
  })
})

describe('parseWorkspaceGroupArgs', () => {
  it('groups your own workspace, or the one named with --workspace', () => {
    expect(parseWorkspaceGroupArgs(['code', 'review'], true)).toEqual({ name: 'code review' })
    expect(parseWorkspaceGroupArgs(['--workspace', 'ws2', 'Work'], true)).toEqual({
      workspace: 'ws2',
      name: 'Work',
    })
    expect(parseWorkspaceGroupArgs(['--workspace', 'ws2'], false)).toEqual({
      workspace: 'ws2',
      name: '',
    })
    expect(parseWorkspaceGroupArgs([], false)).toEqual({ name: '' })
  })

  it('refuses group without a name and ungroup with one', () => {
    expect(() => parseWorkspaceGroupArgs(['--workspace', 'ws2'], true)).toThrow('missing <name>')
    expect(() => parseWorkspaceGroupArgs(['Work'], false)).toThrow('usage: ostia workspace ungroup')
  })
})

describe('parseGroupColorArgs', () => {
  it('takes the group name, which may hold spaces, then a palette colour', () => {
    expect(parseGroupColorArgs(['Work', 'blue'])).toEqual({ group: 'Work', color: 'blue' })
    expect(parseGroupColorArgs(['code', 'review', 'teal'])).toEqual({
      group: 'code review',
      color: 'teal',
    })
    expect(parseGroupColorArgs(['Work', '--clear'])).toEqual({ group: 'Work', color: null })
  })

  it('refuses a colour outside the palette, a missing colour or group', () => {
    expect(() => parseGroupColorArgs(['Work', 'magenta'])).toThrow(
      'usage: ostia workspace group-color',
    )
    expect(() => parseGroupColorArgs(['Work'])).toThrow('usage: ostia workspace group-color')
    expect(() => parseGroupColorArgs(['blue'])).toThrow('usage: ostia workspace group-color')
    expect(() => parseGroupColorArgs(['--clear'])).toThrow('usage: ostia workspace group-color')
  })
})

describe('parseGroupRenameArgs', () => {
  it('takes the group and the new name', () => {
    expect(parseGroupRenameArgs(['Work', 'Billing'])).toEqual({ group: 'Work', name: 'Billing' })
  })

  it('refuses a missing or extra word', () => {
    expect(() => parseGroupRenameArgs(['Work'])).toThrow('usage: ostia workspace group-rename')
    expect(() => parseGroupRenameArgs(['a', 'b', 'c'])).toThrow(
      'usage: ostia workspace group-rename',
    )
    expect(() => parseGroupRenameArgs([])).toThrow('usage: ostia workspace group-rename')
  })
})

describe('parseGroupDeleteArgs', () => {
  it('takes the one group name', () => {
    expect(parseGroupDeleteArgs(['code review'])).toEqual({ group: 'code review' })
  })

  it('refuses an empty name and a name split into words', () => {
    expect(() => parseGroupDeleteArgs(['code', 'review'])).toThrow(
      'usage: ostia workspace group-delete',
    )
    expect(() => parseGroupDeleteArgs([])).toThrow('usage: ostia workspace group-delete')
  })
})
