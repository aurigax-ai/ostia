import { describe, expect, it } from 'vitest'
import { actionFingerprint, actionsFor, fillArgs, parseActions } from './actions'

describe('parseActions', () => {
  it('keeps well-formed actions and drops malformed or duplicate ones', () => {
    const parsed = parseActions([
      { id: 'docs', title: 'Docs', command: 'browser.open', args: { url: 'https://x.dev' } },
      { id: 'docs', title: 'Again', command: 'pane.split' },
      { id: 'Bad Id', title: 'x', command: 'pane.split' },
      { id: 'icon', title: 'x', command: 'pane.split', icon: 'skull' },
      { id: 'place', title: 'x', command: 'pane.split', in: ['statusBar'] },
      { id: 'cmd', title: 'x', command: 'rm -rf /' },
      {
        id: 'split',
        title: 'Split',
        command: 'pane.split',
        icon: 'terminal',
        in: ['paneHeader'],
        paneKinds: ['terminal'],
      },
    ])
    expect(parsed).toEqual([
      {
        id: 'docs',
        title: 'Docs',
        command: 'browser.open',
        args: { url: 'https://x.dev' },
        in: [],
      },
      {
        id: 'split',
        title: 'Split',
        command: 'pane.split',
        icon: 'terminal',
        in: ['paneHeader'],
        paneKinds: ['terminal'],
      },
    ])
  })

  it('returns an empty list for anything that is not an array', () => {
    expect(parseActions({ id: 'x' })).toEqual([])
    expect(parseActions(undefined)).toEqual([])
  })
})

describe('fillArgs', () => {
  it('fills {cwd} and {file} in nested strings and leaves other values alone', () => {
    expect(
      fillArgs(
        { url: 'file://{file}', nested: { dir: '{cwd}/out', list: ['{cwd}', 2] }, n: 1 },
        { cwd: '/w', file: '/w/a.md' },
      ),
    ).toEqual({ url: 'file:///w/a.md', nested: { dir: '/w/out', list: ['/w', 2] }, n: 1 })
  })
})

describe('actionsFor', () => {
  it('returns the actions for a place and pane kind', () => {
    const actions = parseActions([
      { id: 'a', title: 'A', command: 'x', in: ['paneHeader'] },
      { id: 'b', title: 'B', command: 'x', in: ['paneHeader'], paneKinds: ['editor'] },
      { id: 'c', title: 'C', command: 'x', in: ['tabMenu'] },
    ])
    expect(actionsFor(actions, 'paneHeader', 'terminal').map((a) => a.id)).toEqual(['a'])
    expect(actionsFor(actions, 'paneHeader', 'editor').map((a) => a.id)).toEqual(['a', 'b'])
  })
})

describe('actionFingerprint', () => {
  it('changes when the command or its arguments change, not the title', () => {
    const base = { command: 'x', args: { a: 1 } }
    expect(actionFingerprint(base)).toBe(actionFingerprint({ ...base }))
    expect(actionFingerprint(base)).not.toBe(actionFingerprint({ command: 'x', args: { a: 2 } }))
  })
})
