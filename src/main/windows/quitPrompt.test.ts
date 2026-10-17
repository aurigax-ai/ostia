import { describe, expect, it, vi } from 'vitest'

const showMessageBox = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ dialog: { showMessageBox } }))

const {
  MAX_GROUPS,
  MAX_ITEMS_PER_GROUP,
  MAX_NAME_LENGTH,
  cappedLostLines,
  nativeQuitConfirm,
  quitPromptOptions,
} = await import('./quitPrompt')
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

function manyCommands(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `job-${i + 1}`)
}

function groupOf(index: number, commands: string[]) {
  return { workspaceId: `w${index}`, workspace: `ws-${index}`, commands, files: [] }
}

describe('cappedLostLines', () => {
  const text = en.native.quit

  it('leaves a group at or under the item cap unchanged', () => {
    const under = cappedLostLines(text, [groupOf(1, manyCommands(MAX_ITEMS_PER_GROUP - 1))])
    expect(under).toHaveLength(MAX_ITEMS_PER_GROUP)
    expect(under.some((line) => line.includes('more'))).toBe(false)
    const exact = cappedLostLines(text, [groupOf(1, manyCommands(MAX_ITEMS_PER_GROUP))])
    expect(exact).toHaveLength(MAX_ITEMS_PER_GROUP + 1)
    expect(exact.at(-1)).toBe(`  Running: job-${MAX_ITEMS_PER_GROUP}`)
  })

  it('shows the first items of a group and counts the rest', () => {
    const lines = cappedLostLines(text, [groupOf(1, manyCommands(MAX_ITEMS_PER_GROUP + 7))])
    expect(lines).toEqual([
      'ws-1',
      ...manyCommands(MAX_ITEMS_PER_GROUP).map((c) => `  Running: ${c}`),
      '  and 7 more',
    ])
  })

  it('counts commands, agents, files and notes together', () => {
    const lines = cappedLostLines(text, [
      {
        workspaceId: 'w1',
        workspace: 'api',
        commands: manyCommands(2),
        agents: ['claude', 'codex'],
        files: ['/w/a.md', '/w/b.md'],
        scratchFiles: 3,
        unanswered: true,
      },
    ])
    expect(lines).toHaveLength(1 + MAX_ITEMS_PER_GROUP + 1)
    expect(lines.at(-1)).toBe('  and 3 more')
  })

  it('shows the first workspaces and counts the rest', () => {
    const groups = Array.from({ length: MAX_GROUPS + 5 }, (_, i) => groupOf(i + 1, ['make']))
    const lines = cappedLostLines(text, groups)
    expect(lines.filter((line) => line.startsWith('ws-'))).toEqual(
      Array.from({ length: MAX_GROUPS }, (_, i) => `ws-${i + 1}`),
    )
    expect(lines.at(-1)).toBe('and 5 more workspaces')
  })

  it('caps both levels at once and speaks the chosen language', () => {
    const groups = Array.from({ length: MAX_GROUPS + 2 }, (_, i) =>
      groupOf(i + 1, manyCommands(MAX_ITEMS_PER_GROUP + 2)),
    )
    const lines = cappedLostLines(zhHant.native.quit, groups)
    expect(lines).toHaveLength(MAX_GROUPS * (MAX_ITEMS_PER_GROUP + 2) + 1)
    expect(lines.at(-1)).toBe('還有 2 個工作區')
    expect(lines).toContain('  還有 2 項')
  })

  it('clips very long names, workspace names and file names', () => {
    const long = 'x'.repeat(500)
    const lines = cappedLostLines(text, [
      {
        workspaceId: 'w1',
        workspace: long,
        commands: [long],
        agents: [long],
        files: [`/w/${long}.md`],
      },
    ])
    expect(lines[0]).toHaveLength(MAX_NAME_LENGTH)
    expect(lines[0].endsWith('…')).toBe(true)
    for (const line of lines.slice(1)) expect(line.length).toBeLessThan(MAX_NAME_LENGTH + 20)
  })
})

describe('quitPromptOptions with many panes', () => {
  it('keeps the detail short for 60 panes across 12 workspaces', () => {
    const groups = Array.from({ length: 12 }, (_, i) => groupOf(i + 1, manyCommands(6)))
    const options = quitPromptOptions(groups, 3, en.native.quit)
    const lines = options.detail?.split('\n') ?? []
    expect(lines.length).toBeLessThanOrEqual(30)
    expect(lines).toContain('and 9 more workspaces')
    expect(lines).toContain('  and 1 more')
    expect(options.buttons).toEqual(['Cancel', 'Quit and end shells', 'Quit and keep shells'])
    expect(options.defaultId).toBe(2)
    expect(options.cancelId).toBe(0)
  })

  it('keeps the detail short for 60 panes in one workspace', () => {
    const options = quitPromptOptions([groupOf(1, manyCommands(60))], 0, en.native.quit)
    const lines = options.detail?.split('\n') ?? []
    expect(lines.length).toBeLessThanOrEqual(10)
    expect(lines.at(-1)).toBe('  and 55 more')
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
