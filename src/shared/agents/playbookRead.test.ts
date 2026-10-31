import { describe, expect, it } from 'vitest'
import { playbookListText, readPlaybook } from './playbookRead'
import { parsePlaybooks } from './playbooks'

const on = parsePlaybooks({ enabled: { onboard: true } })
const mine = parsePlaybooks({
  enabled: { mine: true, unaccepted: true },
  accepted: { mine: 'Do it' },
  own: {
    mine: { description: 'My own.', text: 'Do it' },
    unaccepted: { description: 'Not yet.', text: 'Wait' },
  },
})

describe('readPlaybook', () => {
  it('answers SKILL.md without a file and a listed file by its exact path', () => {
    expect(readPlaybook(on, 'onboard')).toMatchObject({ ok: true })
    expect(readPlaybook(on, 'onboard', 'SKILL.md')).toEqual(readPlaybook(on, 'onboard'))
    const step = readPlaybook(on, 'onboard', 'steps/scout.md')
    expect(step.ok && step.text).toContain('# Scout')
  })

  it('refuses a playbook that is off, unaccepted or unknown', () => {
    expect(readPlaybook(parsePlaybooks({}), 'onboard').ok).toBe(false)
    expect(readPlaybook(mine, 'unaccepted').ok).toBe(false)
    expect(readPlaybook(mine, 'nope').ok).toBe(false)
  })

  it('refuses any file the playbook does not list, paths included', () => {
    for (const file of [
      '',
      '../SKILL.md',
      '/etc/passwd',
      'steps/../steps/scout.md',
      'steps/x.md',
    ]) {
      expect(readPlaybook(on, 'onboard', file).ok, file).toBe(false)
    }
    expect(readPlaybook(mine, 'mine', 'steps/scout.md').ok).toBe(false)
  })
})

describe('playbookListText', () => {
  it('lists only active playbooks and says nothing when none is on', () => {
    expect(playbookListText(parsePlaybooks({}))).toBe('')
    const text = playbookListText(on)
    expect(text).toContain('- onboard: ')
    expect(text).not.toContain('handoff')
    expect(playbookListText(mine)).toContain('- mine: My own.')
    expect(playbookListText(mine)).not.toContain('unaccepted')
  })
})
