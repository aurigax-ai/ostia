import { en, zhHant } from '@shared/app/dict'
import { describe, expect, it, vi } from 'vitest'
import {
  SLASH_COMMANDS,
  type SlashActions,
  type SlashContext,
  activeRow,
  filterChoices,
  filterSlashCommands,
  findSlashCommand,
  parseSlash,
  pickChoice,
  pickCommand,
  runSlash,
  slashMenu,
  slashRows,
  stepRow,
} from './chatSlash'

function context(over: Partial<SlashContext> = {}): SlashContext {
  return {
    busy: false,
    messageCount: 2,
    lastRole: 'assistant',
    recording: true,
    provider: true,
    tools: true,
    skillFolders: 1,
    skills: [
      { name: 'pdf', description: 'Read and fill PDFs' },
      { name: 'release-notes', description: 'Write release notes' },
    ],
    skillsOn: true,
    sessions: [
      { id: 's-deploy', title: 'Deploy notes' },
      { id: 's-ports', title: 'Ports on linux' },
    ],
    sources: [
      { value: 'selection', label: 'Terminal selection' },
      { value: 'output', label: 'Output of make' },
    ],
    ...over,
  }
}

function actions(): SlashActions & Record<string, ReturnType<typeof vi.fn>> {
  return {
    newChat: vi.fn(),
    clear: vi.fn(),
    openSessions: vi.fn(),
    openSession: vi.fn(),
    rename: vi.fn(),
    exportMarkdown: vi.fn(),
    retry: vi.fn(),
    explain: vi.fn(),
    attach: vi.fn(),
    openTools: vi.fn(),
    applySkill: vi.fn(),
    showModel: vi.fn(),
    showHelp: vi.fn(),
  }
}

const command = (id: string) => {
  const found = findSlashCommand(id)
  if (!found) throw new Error(`no /${id}`)
  return found
}

describe('parseSlash', () => {
  it('reads the command name and argument when the draft starts with a slash', () => {
    expect(parseSlash('/new')).toEqual({ name: 'new', arg: '', spaced: false })
    expect(parseSlash('  /rename Release  plan')).toEqual({
      name: 'rename',
      arg: 'Release  plan',
      spaced: true,
    })
    expect(parseSlash('\n/skill ')).toEqual({ name: 'skill', arg: '', spaced: true })
  })

  it('ignores a slash that is not at the start of the draft', () => {
    expect(parseSlash('what does /new do')).toBeNull()
    expect(parseSlash('')).toBeNull()
  })
})

describe('filterSlashCommands', () => {
  it('lists every command for a bare slash', () => {
    expect(filterSlashCommands('').map((c) => c.id)).toEqual(SLASH_COMMANDS.map((c) => c.id))
  })

  it('ranks name prefixes before other matches and also matches titles', () => {
    expect(filterSlashCommands('re').map((c) => c.id)).toEqual(['rename', 'retry'])
    const titles = (id: string) => en.chatSlash.commands[id as keyof typeof en.chatSlash.commands]
    expect(filterSlashCommands('chat', (id) => titles(id).title).map((c) => c.id)).toEqual([
      'new',
      'clear',
      'sessions',
    ])
  })

  it('matches names without regard to case', () => {
    expect(filterSlashCommands('HE').map((c) => c.id)).toEqual(['help'])
  })
})

describe('slashMenu', () => {
  it('lists matching commands while the name is typed', () => {
    expect(slashMenu('/ex', context())).toMatchObject({
      phase: 'command',
      query: 'ex',
      commands: [{ id: 'export' }, { id: 'explain' }],
    })
  })

  it('closes when no command matches, so the text can go to the model', () => {
    expect(slashMenu('/usr/bin/env why', context())).toBeNull()
    expect(slashMenu('/zzz', context())).toBeNull()
  })

  it('completes a skill name from the configured skills', () => {
    const menu = slashMenu('/skill re', context())
    expect(menu).toMatchObject({ phase: 'arg', choices: [{ value: 'release-notes' }] })
  })

  it('stops completing the skill once its name is followed by a space', () => {
    expect(slashMenu('/skill pdf ', context())).toBeNull()
  })

  it('completes saved chats by title', () => {
    expect(slashMenu('/sessions port', context())).toMatchObject({
      phase: 'arg',
      choices: [{ value: 's-ports', label: 'Ports on linux' }],
    })
  })

  it('offers no completion for a command that is unavailable or takes free text', () => {
    expect(slashMenu('/skill ', context({ skills: [] }))).toBeNull()
    expect(slashMenu('/rename ', context())).toBeNull()
  })
})

describe('filterChoices', () => {
  it('puts prefix matches first', () => {
    const choices = [
      { value: 'a', label: 'Notes on deploy' },
      { value: 'b', label: 'Deploy notes' },
    ]
    expect(filterChoices(choices, 'deploy').map((c) => c.value)).toEqual(['b', 'a'])
  })
})

describe('availability', () => {
  const reason = (id: string, ctx: SlashContext) => command(id).unavailable(ctx)

  it('disables /retry until there is an answer, and while one streams', () => {
    expect(reason('retry', context({ lastRole: 'user' }))).toBe('noAnswer')
    expect(reason('retry', context({ messageCount: 0, lastRole: null }))).toBe('noAnswer')
    expect(reason('retry', context({ busy: true }))).toBe('busy')
    expect(reason('retry', context())).toBeNull()
  })

  it('explains why /skill is unavailable', () => {
    expect(reason('skill', context({ skills: [], skillFolders: 0 }))).toBe('noSkillFolders')
    expect(reason('skill', context({ skills: [], skillFolders: 2 }))).toBe('noSkills')
    expect(reason('skill', context({ skillsOn: false }))).toBe('skillsOff')
    expect(reason('skill', context({ tools: false }))).toBe('noTools')
    expect(reason('skill', context({ provider: false }))).toBe('noProvider')
  })

  it('disables /tools when the model uses no tools', () => {
    expect(reason('tools', context({ tools: false }))).toBe('noTools')
  })

  it('disables /clear and /export on an empty chat, and /export while history is off', () => {
    expect(reason('clear', context({ messageCount: 0 }))).toBe('empty')
    expect(reason('export', context({ messageCount: 0 }))).toBe('empty')
    expect(reason('export', context({ recording: false }))).toBe('notSaved')
  })

  it('disables /explain when there is nothing to explain', () => {
    expect(reason('explain', context({ sources: [] }))).toBe('noSource')
  })

  it('keeps /help, /model and /attach always available', () => {
    const empty = context({ provider: false, tools: false, messageCount: 0, lastRole: null })
    for (const id of ['help', 'model', 'attach', 'rename', 'sessions']) {
      expect(reason(id, empty)).toBeNull()
    }
  })
})

describe('runSlash', () => {
  it('returns null for text that is not a command, so it is sent as a question', () => {
    const acts = actions()
    expect(runSlash('/usr/bin/env is what?', context(), acts)).toBeNull()
    expect(runSlash('hello', context(), acts)).toBeNull()
  })

  it('runs a command locally', () => {
    const acts = actions()
    expect(runSlash('/new', context(), acts)).toEqual({ id: 'new', ran: true })
    expect(acts.newChat).toHaveBeenCalledOnce()
    runSlash('/HELP', context(), acts)
    expect(acts.showHelp).toHaveBeenCalledOnce()
  })

  it('does not run an unavailable command and says why', () => {
    const acts = actions()
    expect(runSlash('/new', context({ busy: true }), acts)).toEqual({
      id: 'new',
      ran: false,
      reason: 'busy',
    })
    expect(acts.newChat).not.toHaveBeenCalled()
  })

  it('renames with the trimmed title and asks for one when it is missing', () => {
    const acts = actions()
    expect(runSlash('/rename', context(), acts)).toMatchObject({ reason: 'needsTitle' })
    runSlash('/rename   Release plan ', context(), acts)
    expect(acts.rename).toHaveBeenCalledWith('Release plan')
  })

  it('passes the skill name and the task after it', () => {
    const acts = actions()
    runSlash('/skill PDF fill in the form', context(), acts)
    expect(acts.applySkill).toHaveBeenCalledWith('pdf', 'fill in the form')
    runSlash('/skill release-notes', context(), acts)
    expect(acts.applySkill).toHaveBeenLastCalledWith('release-notes', '')
    expect(runSlash('/skill nope', context(), acts)).toMatchObject({ reason: 'unknownSkill' })
    expect(runSlash('/skill', context(), acts)).toMatchObject({ reason: 'needsSkill' })
  })

  it('opens the session list, or the chat whose title matches', () => {
    const acts = actions()
    runSlash('/sessions', context(), acts)
    expect(acts.openSessions).toHaveBeenCalledOnce()
    runSlash('/sessions deploy', context(), acts)
    expect(acts.openSession).toHaveBeenCalledWith('s-deploy')
    runSlash('/sessions s-ports', context(), acts)
    expect(acts.openSession).toHaveBeenLastCalledWith('s-ports')
    expect(runSlash('/sessions missing', context(), acts)).toMatchObject({
      reason: 'unknownSession',
    })
  })

  it('explains the chosen source, or the first one when none is named', () => {
    const acts = actions()
    runSlash('/explain output', context(), acts)
    expect(acts.explain).toHaveBeenCalledWith('output')
    runSlash('/explain', context(), acts)
    expect(acts.explain).toHaveBeenLastCalledWith('selection')
    expect(runSlash('/explain block', context(), acts)).toMatchObject({ reason: 'unknownSource' })
  })

  it('opens the @ picker with the typed path', () => {
    const acts = actions()
    runSlash('/attach src/ma', context(), acts)
    expect(acts.attach).toHaveBeenCalledWith('src/ma')
  })
})

describe('picking from the menu', () => {
  it('runs a command without an argument on Enter and completes it on Tab', () => {
    expect(pickCommand(command('new'), context(), false)).toEqual({ kind: 'run', draft: '/new' })
    expect(pickCommand(command('new'), context(), true)).toEqual({ kind: 'fill', draft: '/new' })
  })

  it('asks for a required argument before running', () => {
    expect(pickCommand(command('rename'), context(), false)).toEqual({
      kind: 'fill',
      draft: '/rename ',
    })
    expect(pickCommand(command('skill'), context(), false)).toEqual({
      kind: 'fill',
      draft: '/skill ',
    })
  })

  it('lets the human pick what /explain sends when there is more than one source', () => {
    expect(pickCommand(command('explain'), context(), false).kind).toBe('fill')
    const one = context({ sources: [{ value: 'output', label: 'Output of make' }] })
    expect(pickCommand(command('explain'), one, false)).toEqual({ kind: 'run', draft: '/explain' })
  })

  it('opens the session list on Enter and completes chats on Tab', () => {
    expect(pickCommand(command('sessions'), context(), false).kind).toBe('run')
    expect(pickCommand(command('sessions'), context(), true)).toEqual({
      kind: 'fill',
      draft: '/sessions ',
    })
  })

  it('completes a skill so a task can follow, and runs other choices', () => {
    expect(pickChoice(command('skill'), { value: 'pdf', label: 'pdf' })).toEqual({
      kind: 'fill',
      draft: '/skill pdf ',
    })
    expect(pickChoice(command('sessions'), { value: 's-ports', label: 'Ports' })).toEqual({
      kind: 'run',
      draft: '/sessions s-ports',
    })
  })
})

describe('menu rows', () => {
  it('marks unavailable commands with their reason and starts on the first available one', () => {
    const ctx = context({ lastRole: 'user', busy: false })
    const menu = slashMenu('/re', ctx)
    if (!menu) throw new Error('menu expected')
    const rows = slashRows(menu, ctx)
    expect(rows.map((r) => [r.key, r.reason])).toEqual([
      ['/rename', null],
      ['/retry', 'noAnswer'],
    ])
    expect(activeRow(rows, null)?.key).toBe('/rename')
    expect(activeRow(rows, '/retry')?.key).toBe('/retry')
  })

  it('wraps when stepping past either end', () => {
    const menu = slashMenu('/re', context())
    if (!menu) throw new Error('menu expected')
    const rows = slashRows(menu, context())
    expect(stepRow(rows, '/retry', 1)).toBe('/rename')
    expect(stepRow(rows, '/rename', -1)).toBe('/retry')
  })
})

describe('strings', () => {
  it('has a title, a description and an argument label for every command in every locale', () => {
    for (const dict of [en, zhHant]) {
      for (const c of SLASH_COMMANDS) {
        expect(dict.chatSlash.commands[c.id].title).toBeTruthy()
        expect(dict.chatSlash.commands[c.id].description).toBeTruthy()
        if (c.arg) expect(dict.chatSlash.args[c.arg.kind]).toBeTruthy()
      }
    }
  })
})
