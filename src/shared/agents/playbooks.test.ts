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
  withPlaybookEnabled,
  withPlaybookReset,
  withPlaybookText,
} from './playbooks'

const builtin = (id: string) => {
  const found = BUILTIN_PLAYBOOKS.find((p) => p.id === id)
  if (!found) throw new Error(id)
  return found
}

describe('playbook names', () => {
  it('accepts a lowercase command and refuses the rest', () => {
    expect(playbookNameProblem('release-check', [])).toBeNull()
    for (const bad of ['', 'Release', '1abc', 'a_b', 'a b', '-x', 'x'.repeat(33)]) {
      expect(playbookNameProblem(bad, [])).toBe('invalid')
    }
  })

  it('reserves the built-in names and ostia, and refuses a taken one', () => {
    for (const id of ['coordinator', 'worker', 'review', 'remember', 'ostia']) {
      expect(playbookNameProblem(id, [])).toBe('reserved')
    }
    expect(playbookNameProblem('mine', ['mine'])).toBe('taken')
  })
})

describe('playbook text', () => {
  it('refuses empty, long and control characters', () => {
    expect(playbookTextProblem('  \n')).toBe('empty')
    expect(playbookTextProblem('x'.repeat(PLAYBOOK_TEXT_MAX + 1))).toBe('long')
    expect(playbookTextProblem('a\u0000b')).toBe('control')
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
    expect(playbookTextProblem('Task: $ARGUMENTS and `code` and a ! mark')).toBeNull()
  })

  it('keeps the built-in prompts clean', () => {
    for (const p of BUILTIN_PLAYBOOKS) {
      expect(playbookTextProblem(p.text)).toBeNull()
      expect(p.text.length).toBeLessThan(PLAYBOOK_TEXT_MAX)
    }
  })
})

describe('playbook description', () => {
  it('is one non-empty line of at most 120 characters', () => {
    expect(playbookDescriptionProblem('')).toBe('empty')
    expect(playbookDescriptionProblem('x'.repeat(121))).toBe('long')
    expect(playbookDescriptionProblem('two\nlines')).toBe('control')
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
      enabled: { coordinator: true, Bad: true, worker: 'yes' },
      edits: {
        coordinator: { text: 'mine', from: 'abc' },
        unknown: { text: 'x', from: 'y' },
        review: { text: 4, from: 'y' },
      },
      own: {
        'release-check': { description: 'Check', text: 'Do it', enabled: true },
        review: { description: 'clash', text: 'x', enabled: true },
        'Bad Name': { description: 'x', text: 'x', enabled: true },
      },
    })
    expect(parsed.enabled).toEqual({ coordinator: true })
    expect(parsed.edits).toEqual({ coordinator: { text: 'mine', from: 'abc' } })
    expect(Object.keys(parsed.own)).toEqual(['release-check'])
  })

  it('caps the number and size of own playbooks', () => {
    const own = Object.fromEntries(
      Array.from({ length: OWN_PLAYBOOKS_MAX + 5 }, (_, i) => [
        `p${i}`,
        { description: 'd', text: 'x'.repeat(PLAYBOOK_TEXT_MAX + 50), enabled: false },
      ]),
    )
    const parsed = parsePlaybooks({ own })
    expect(Object.keys(parsed.own)).toHaveLength(OWN_PLAYBOOKS_MAX)
    expect(parsed.own.p0.text).toHaveLength(PLAYBOOK_TEXT_MAX)
  })
})

describe('resolvePlaybooks', () => {
  it('turns only remember on by default', () => {
    const on = resolvePlaybooks(DEFAULT_PLAYBOOKS)
      .filter((p) => p.enabled)
      .map((p) => p.id)
    expect(on).toEqual(['remember'])
  })

  it('keeps the human text of an edited built-in and notices a changed default', () => {
    const base = builtin('coordinator')
    const edited = withPlaybookText(DEFAULT_PLAYBOOKS, 'coordinator', `${base.text}\nExtra.`)
    const [first] = resolvePlaybooks(edited)
    expect(first.edited).toBe(true)
    expect(first.text).toBe(`${base.text}\nExtra.`)
    expect(first.defaultChanged).toBe(false)

    const stale = { ...edited, edits: { coordinator: { text: first.text, from: 'old00000' } } }
    const [again] = resolvePlaybooks(stale)
    expect(again.text).toBe(first.text)
    expect(again.defaultChanged).toBe(true)
    expect(again.defaultText).toBe(base.text)
  })

  it('treats an edit equal to the default as no edit', () => {
    const base = builtin('worker')
    const edited = withPlaybookText(DEFAULT_PLAYBOOKS, 'worker', 'x')
    const back = withPlaybookText(edited, 'worker', base.text)
    expect(back.edits).toEqual({})
    expect(resolvePlaybooks(back)[1].edited).toBe(false)
  })

  it('keeps the first default hash across later edits', () => {
    const base = builtin('review')
    const once = withPlaybookText(DEFAULT_PLAYBOOKS, 'review', 'one')
    const twice = withPlaybookText(once, 'review', 'two')
    expect(twice.edits.review).toEqual({ text: 'two', from: playbookHash(base.text) })
  })
})

describe('playbook updates', () => {
  it('switches built-in and own playbooks and ignores unknown ids', () => {
    const own = withOwnPlaybook(DEFAULT_PLAYBOOKS, 'mine', { description: 'd', text: 't' })
    expect(own.own.mine.enabled).toBe(false)
    expect(withPlaybookEnabled(own, 'mine', true).own.mine.enabled).toBe(true)
    expect(withPlaybookEnabled(own, 'review', true).enabled).toEqual({ review: true })
    expect(withPlaybookEnabled(own, 'nope', true)).toBe(own)
    expect(withPlaybookText(own, 'nope', 'x')).toBe(own)
  })

  it('renames an own playbook and keeps its switch', () => {
    const on = withPlaybookEnabled(
      withOwnPlaybook(DEFAULT_PLAYBOOKS, 'old', { description: 'd', text: 't' }),
      'old',
      true,
    )
    const renamed = withOwnPlaybook(on, 'new', { description: 'd2', text: 't' }, 'old')
    expect(Object.keys(renamed.own)).toEqual(['new'])
    expect(renamed.own.new).toEqual({ description: 'd2', text: 't', enabled: true })
    expect(withoutOwnPlaybook(renamed, 'new').own).toEqual({})
  })

  it('resets an edit', () => {
    const edited = withPlaybookText(DEFAULT_PLAYBOOKS, 'review', 'x')
    expect(withPlaybookReset(edited, 'review').edits).toEqual({})
  })
})

describe('activePlaybooks and the skill text', () => {
  it('lists only enabled, valid playbooks', () => {
    let s = withOwnPlaybook(DEFAULT_PLAYBOOKS, 'good', { description: 'ok', text: 'Do it' })
    s = withOwnPlaybook(s, 'shell', { description: 'ok', text: 'run !`id`' })
    s = withOwnPlaybook(s, 'blank', { description: '', text: 'Do it' })
    for (const id of ['good', 'shell', 'blank', 'worker']) s = withPlaybookEnabled(s, id, true)
    expect(activePlaybooks(s).map((p) => p.id)).toEqual(['worker', 'remember', 'good'])
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
