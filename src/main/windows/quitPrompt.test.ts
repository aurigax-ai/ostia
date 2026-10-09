import { describe, expect, it, vi } from 'vitest'

const showMessageBox = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ dialog: { showMessageBox } }))

const { confirmQuitNatively, quitPromptOptions } = await import('./quitPrompt')
const { en, zhHant } = await import('../../shared/dict')

const GROUPS = [
  {
    workspaceId: 'w1',
    workspace: 'api',
    commands: ['make', ''],
    agents: ['claude'],
    files: ['/w/notes.md'],
    scratchFiles: 2,
  },
  { workspaceId: 'w2', workspace: 'web', commands: [], files: [], unanswered: true },
]

describe('quitPromptOptions', () => {
  it('lists what each workspace loses and defaults to Cancel', () => {
    const options = quitPromptOptions(GROUPS, en.native.quit)
    expect(options.buttons).toEqual(['Cancel', 'Quit'])
    expect(options.cancelId).toBe(0)
    expect(options.defaultId).toBe(0)
    expect(options.detail?.split('\n')).toEqual([
      'Quitting ends or discards everything listed here.',
      '',
      'api',
      '  Running: make',
      '  Running: a command',
      '  Agent: claude',
      '  Unsaved: notes.md',
      '  Files in the scratch folder: 2',
      'web',
      '  The window did not answer, so it may have running commands or unsaved files',
    ])
  })

  it('speaks the language of the catalog it is given', () => {
    expect(quitPromptOptions(GROUPS, zhHant.native.quit).buttons).toEqual(['取消', '結束'])
  })
})

describe('confirmQuitNatively', () => {
  it('quits only on the Quit button', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    expect(await confirmQuitNatively(GROUPS, en.native.quit)).toBe(true)
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    expect(await confirmQuitNatively(GROUPS, en.native.quit)).toBe(false)
  })
})
