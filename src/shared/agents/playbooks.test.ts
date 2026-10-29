import { describe, expect, it } from 'vitest'
import {
  activePlaybooks,
  BUILTIN_PLAYBOOKS,
  DEFAULT_PLAYBOOKS,
  OWN_PLAYBOOKS_MAX,
  PLAYBOOK_TEXT_MAX,
  parsePlaybooks,
  playbookDescriptionProblem,
  playbookHash,
  playbookNameProblem,
  playbookSkillText,
  playbookTextProblem,
  resolvePlaybooks,
  withOwnPlaybook,
  withoutOwnPlaybook,
  withPlaybookAccepted,
  withPlaybookEnabled,
  withPlaybookReset,
  withPlaybookText,
} from './playbooks'

const builtin = (id: string) => {
  const found = BUILTIN_PLAYBOOKS.find((p) => p.id === id)
  if (!found) throw new Error(id)
  return found
}

const char = (code: number): string => String.fromCharCode(code)

describe('playbook names', () => {
  it('accepts a lowercase command and refuses the rest', () => {
    expect(playbookNameProblem('release-check', [], [])).toBeNull()
    for (const bad of ['', 'Release', '1abc', 'a_b', 'a b', '-x', 'x'.repeat(33)]) {
      expect(playbookNameProblem(bad, [], [])).toBe('invalid')
    }
  })

  it('reserves the built-in names, the product name and Claude Code’s own commands', () => {
    for (const id of ['onboard', 'handoff', 'review', 'ostia']) {
      expect(playbookNameProblem(id, [], [])).toBe('reserved')
    }
    for (const id of ['clear', 'init', 'compact', 'help', 'simplify', 'security-review']) {
      expect(playbookNameProblem(id, [], [])).toBe('reserved')
    }
  })

  it('refuses a name an extension skill already has, and a taken one', () => {
    expect(playbookNameProblem('kit-review', [], ['kit-review'])).toBe('extension')
    expect(playbookNameProblem('mine', ['mine'], [])).toBe('taken')
  })
})

describe('playbook text', () => {
  it('refuses empty, long and control characters', () => {
    expect(playbookTextProblem('  \n')).toBe('empty')
    expect(playbookTextProblem('x'.repeat(PLAYBOOK_TEXT_MAX + 1))).toBe('long')
    expect(playbookTextProblem(`a${char(0)}b`)).toBe('control')
    expect(playbookTextProblem('line one\n\tline two\r\n')).toBeNull()
  })

  it('refuses shell injection in every form Claude would run at load', () => {
    const bad = [
      'run !`git log`',
      'run !$(id)',
      '```!\nls\n```',
      '~~~ !\nls',
      '```$\nls\n```',
      'full width ！`id`',
    ]
    for (const text of bad) expect(playbookTextProblem(text)).toBe('shell')
    expect(playbookTextProblem('The task:\n\n$ARGUMENTS\n and `code` and a ! mark')).toBeNull()
  })

  it('refuses $ARGUMENTS right after a bang or a fence', () => {
    for (const text of [
      '!$ARGUMENTS',
      'run !$ARGUMENTS now',
      '```$ARGUMENTS\nx\n```',
      '~~~ $ARGUMENTS',
    ]) {
      expect(playbookTextProblem(text)).toBe('shell')
    }
    expect(playbookTextProblem('Do it.\n\n$ARGUMENTS')).toBeNull()
  })

  it('keeps the built-in prompts clean, with $ARGUMENTS alone on a line after plain text', () => {
    for (const p of BUILTIN_PLAYBOOKS) {
      expect(playbookTextProblem(p.text)).toBeNull()
      expect(p.text.length).toBeLessThan(PLAYBOOK_TEXT_MAX)
      const lines = p.text.split('\n')
      expect(p.text.split('$ARGUMENTS')).toHaveLength(2)
      const at = lines.indexOf('$ARGUMENTS')
      expect(at).toBeGreaterThan(1)
      expect(lines[at - 1]).toBe('')
      expect(lines[at - 2]).toMatch(/^[A-Za-z][^`~!]*:?$/)
    }
  })
})

describe('playbook description', () => {
  it('is one non-empty line of at most 120 characters, without format characters', () => {
    expect(playbookDescriptionProblem('')).toBe('empty')
    expect(playbookDescriptionProblem('x'.repeat(121))).toBe('long')
    expect(playbookDescriptionProblem('two\nlines')).toBe('control')
    expect(playbookDescriptionProblem(`a${char(0x200b)}b`)).toBe('control')
    expect(playbookDescriptionProblem(`a${char(0x202e)}b`)).toBe('control')
    expect(playbookDescriptionProblem('Confirm before a tag.')).toBeNull()
  })
})

describe('parsePlaybooks', () => {
  it('returns the defaults for anything that is not an object', () => {
    for (const raw of [undefined, null, 4, 'x', []]) {
      expect(parsePlaybooks(raw)).toEqual(DEFAULT_PLAYBOOKS)
    }
  })

  it('keeps well-formed data and drops the rest', () => {
    const parsed = parsePlaybooks({
      enabled: { onboard: true, Bad: true, handoff: 'yes', 'release-check': true },
      accepted: { onboard: 'mine', Bad: 'x', handoff: 4 },
      edits: {
        onboard: { text: 'mine', from: 'abc' },
        unknown: { text: 'x', from: 'y' },
        review: { text: 4, from: 'y' },
      },
      own: {
        'release-check': { description: 'Check', text: 'Do it', enabled: true },
        review: { description: 'clash', text: 'x' },
        clear: { description: 'claude command', text: 'x' },
        'Bad Name': { description: 'x', text: 'x' },
      },
    })
    expect(parsed.enabled).toEqual({ onboard: true, 'release-check': true })
    expect(parsed.accepted).toEqual({ onboard: 'mine' })
    expect(parsed.edits).toEqual({ onboard: { text: 'mine', from: 'abc' } })
    expect(parsePlaybooks({ edits: { coordinator: { text: 'old', from: 'abc' } } }).edits).toEqual(
      {},
    )
    expect(parsed.own).toEqual({ 'release-check': { description: 'Check', text: 'Do it' } })
  })

  it('caps the number and size of own playbooks', () => {
    const own = Object.fromEntries(
      Array.from({ length: OWN_PLAYBOOKS_MAX + 5 }, (_, i) => [
        `p${i}`,
        { description: 'd', text: 'x'.repeat(PLAYBOOK_TEXT_MAX + 50) },
      ]),
    )
    const parsed = parsePlaybooks({ own })
    expect(Object.keys(parsed.own)).toHaveLength(OWN_PLAYBOOKS_MAX)
    expect(parsed.own.p0.text).toHaveLength(PLAYBOOK_TEXT_MAX)
  })
})

describe('resolvePlaybooks', () => {
  it('turns no built-in on by default', () => {
    const on = resolvePlaybooks(DEFAULT_PLAYBOOKS)
      .filter((p) => p.enabled)
      .map((p) => p.id)
    expect(on).toEqual([])
  })

  it('applies a text the human wrote here, and notices a changed default', () => {
    const base = builtin('onboard')
    const edited = withPlaybookText(DEFAULT_PLAYBOOKS, 'onboard', `${base.text}\nExtra.`)
    const [first] = resolvePlaybooks(edited)
    expect(first.edited).toBe(true)
    expect(first.text).toBe(`${base.text}\nExtra.`)
    expect(first.defaultChanged).toBe(false)
    expect(first.unaccepted).toBeNull()

    const stale = { ...edited, edits: { onboard: { text: first.text, from: 'old00000' } } }
    const [again] = resolvePlaybooks(stale)
    expect(again.text).toBe(first.text)
    expect(again.defaultChanged).toBe(true)
    expect(again.defaultText).toBe(base.text)
  })

  it('does not use an edit that arrived from another device until it is accepted here', () => {
    const base = builtin('onboard')
    const synced = {
      ...DEFAULT_PLAYBOOKS,
      enabled: { onboard: true },
      edits: { onboard: { text: 'Pushed from elsewhere.', from: playbookHash(base.text) } },
    }
    const [waiting] = resolvePlaybooks(synced)
    expect(waiting.text).toBe(base.text)
    expect(waiting.edited).toBe(false)
    expect(waiting.unaccepted).toBe('Pushed from elsewhere.')
    expect(activePlaybooks(synced).find((p) => p.id === 'onboard')?.text).toBe(base.text)

    const [taken] = resolvePlaybooks(withPlaybookAccepted(synced, 'onboard'))
    expect(taken.text).toBe('Pushed from elsewhere.')
    expect(taken.edited).toBe(true)
    expect(taken.unaccepted).toBeNull()
  })

  it('does not use a synced edit that differs from the one accepted here', () => {
    const accepted = withPlaybookText(DEFAULT_PLAYBOOKS, 'handoff', 'Mine.')
    const replaced = { ...accepted, edits: { handoff: { text: 'Theirs.', from: 'x' } } }
    const found = resolvePlaybooks(replaced).find((p) => p.id === 'handoff')
    expect(found?.text).toBe(builtin('handoff').text)
    expect(found?.unaccepted).toBe('Theirs.')
  })

  it('leaves an own playbook that arrived from another device off until accepted', () => {
    const synced = { ...DEFAULT_PLAYBOOKS, own: { mine: { description: 'd', text: 'Do it.' } } }
    const on = withPlaybookEnabled(synced, 'mine', true)
    expect(resolvePlaybooks(synced).at(-1)?.enabled).toBe(false)
    expect(activePlaybooks(on).map((p) => p.id)).not.toContain('mine')
    expect(activePlaybooks(withPlaybookAccepted(on, 'mine')).map((p) => p.id)).toContain('mine')
  })

  it('treats an edit equal to the default as no edit', () => {
    const base = builtin('handoff')
    const edited = withPlaybookText(DEFAULT_PLAYBOOKS, 'handoff', 'x')
    const back = withPlaybookText(edited, 'handoff', base.text)
    expect(back.edits).toEqual({})
    expect(back.accepted).toEqual({})
    expect(resolvePlaybooks(back)[1].edited).toBe(false)
  })

  it('keeps the first default hash across later edits', () => {
    const base = builtin('onboard')
    const once = withPlaybookText(DEFAULT_PLAYBOOKS, 'onboard', 'one')
    const twice = withPlaybookText(once, 'onboard', 'two')
    expect(twice.edits.onboard).toEqual({ text: 'two', from: playbookHash(base.text) })
  })
})

describe('playbook updates', () => {
  it('switches built-in and own playbooks and ignores unknown ids', () => {
    const own = withOwnPlaybook(DEFAULT_PLAYBOOKS, 'mine', { description: 'd', text: 't' })
    expect(own.enabled).toEqual({})
    expect(withPlaybookEnabled(own, 'mine', true).enabled).toEqual({ mine: true })
    expect(withPlaybookEnabled(own, 'onboard', true).enabled).toEqual({ onboard: true })
    expect(withPlaybookEnabled(own, 'nope', true)).toBe(own)
    expect(withPlaybookText(own, 'nope', 'x')).toBe(own)
  })

  it('renames an own playbook and keeps its switch, and removes every trace on delete', () => {
    const on = withPlaybookEnabled(
      withOwnPlaybook(DEFAULT_PLAYBOOKS, 'old', { description: 'd', text: 't' }),
      'old',
      true,
    )
    const renamed = withOwnPlaybook(on, 'new', { description: 'd2', text: 't' }, 'old')
    expect(Object.keys(renamed.own)).toEqual(['new'])
    expect(renamed.enabled).toEqual({ new: true })
    expect(renamed.accepted).toEqual({ new: 't' })
    const gone = withoutOwnPlaybook(renamed, 'new')
    expect(gone).toEqual(DEFAULT_PLAYBOOKS)
  })

  it('resets an edit and forgets what was accepted', () => {
    const edited = withPlaybookText(DEFAULT_PLAYBOOKS, 'onboard', 'x')
    expect(withPlaybookReset(edited, 'onboard')).toEqual(DEFAULT_PLAYBOOKS)
  })
})

describe('activePlaybooks and the skill text', () => {
  it('lists only enabled, valid playbooks', () => {
    let s = withOwnPlaybook(DEFAULT_PLAYBOOKS, 'good', { description: 'ok', text: 'Do it' })
    s = withOwnPlaybook(s, 'shell', { description: 'ok', text: 'run !`id`' })
    s = withOwnPlaybook(s, 'blank', { description: '', text: 'Do it' })
    for (const id of ['good', 'shell', 'blank', 'handoff']) s = withPlaybookEnabled(s, id, true)
    expect(activePlaybooks(s).map((p) => p.id)).toEqual(['handoff', 'good'])
  })

  it('writes Ostia’s own frontmatter, human-invoked only, with the description quoted', () => {
    const s = withPlaybookEnabled(
      withOwnPlaybook(DEFAULT_PLAYBOOKS, 'tricky', {
        description: 'Note: "quoted"   text',
        text: 'Body.\n',
      }),
      'tricky',
      true,
    )
    const [playbook] = activePlaybooks(s).filter((p) => p.id === 'tricky')
    expect(playbookSkillText(playbook)).toBe(
      [
        '---',
        'name: tricky',
        'description: "Note: \\"quoted\\" text"',
        'argument-hint: "[task]"',
        'disable-model-invocation: true',
        '---',
        '',
        'Body.',
        '',
      ].join('\n'),
    )
  })
})
