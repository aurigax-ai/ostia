import { describe, expect, it, vi } from 'vitest'

const showMessageBox = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ dialog: { showMessageBox } }))

const { nativeQuitConfirm, quitPromptOptions } = await import('./quitPrompt')
const { en, zhHant } = await import('../../shared/app/dict')

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
    const options = quitPromptOptions(GROUPS, 0, en.native.quit)
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
    expect(quitPromptOptions(GROUPS, 0, zhHant.native.quit).buttons).toEqual(['取消', '結束'])
  })
})

describe('quitPromptOptions with kept shells', () => {
  it('KSH-C100 says the kept shells end on Quit and defaults to keeping them', () => {
    const options = quitPromptOptions([], 2, en.native.quit)
    expect(options.message).toBe('Quit with kept shells running?')
    expect(options.buttons).toEqual(['Cancel', 'Quit and end shells', 'Quit and keep shells'])
    expect(options.cancelId).toBe(0)
    expect(options.defaultId).toBe(2)
    expect(options.detail?.split('\n')).toEqual([
      '2 kept shells are running',
      'Quit and keep shells leaves them running in tmux, and the next start reattaches them. Quit and end shells ends them.',
    ])
  })

  it('lists what the quit loses above the kept shells', () => {
    const options = quitPromptOptions(GROUPS.slice(1), 1, en.native.quit)
    expect(options.message).toBe('Quit and lose this work?')
    expect(options.detail?.split('\n')).toEqual([
      'Quitting ends or discards everything listed here.',
      '',
      'web',
      '  The window did not answer, so it may have running commands or unsaved files',
      '',
      '1 kept shell is running',
      'Quit and keep shells leaves them running in tmux, and the next start reattaches them. Quit and end shells ends them.',
    ])
  })
})

describe('nativeQuitConfirm', () => {
  const confirm = nativeQuitConfirm(() => en)

  it('quits only on the Quit button', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    expect(await confirm(GROUPS, 0)).toBe('quit')
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    expect(await confirm(GROUPS, 0)).toBe('cancel')
    showMessageBox.mockResolvedValueOnce({ response: 2 })
    expect(await confirm(GROUPS, 0)).toBe('cancel')
  })

  it('KSH-C101 answers keep-shells or quit when kept shells are offered', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 2 })
    expect(await confirm([], 1)).toBe('keep-shells')
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    expect(await confirm([], 1)).toBe('quit')
  })

  it('the main process asks in the language of the chosen pack: the native quit prompt', async () => {
    let catalog = zhHant
    const ask = nativeQuitConfirm(() => catalog)
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    expect(await ask([GROUPS[1]], 0)).toBe('cancel')
    expect(showMessageBox).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: zhHant.native.quit.title,
        detail: expect.stringContaining(zhHant.native.quit.unanswered),
        buttons: [zhHant.native.quit.cancel, zhHant.native.quit.quit],
      }),
    )
    catalog = en
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    await ask([GROUPS[1]], 0)
    expect(showMessageBox).toHaveBeenLastCalledWith(
      expect.objectContaining({ buttons: [en.native.quit.cancel, en.native.quit.quit] }),
    )
  })
})
