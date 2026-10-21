import { describe, expect, it } from 'vitest'
import {
  PHRASING_PROMPT_CHARS,
  PHRASING_PROMPTS_MAX,
  parsePhrasing,
  phrasingInput,
} from './phrasing'

const known = new Set(['r1', 'r2'])

describe('parsePhrasing', () => {
  it('reads the fixed shape, even around chatter', () => {
    const text =
      'Sure!\n{"rule":" Write no comments. ","why":"it is noise","when":"","sameAs":null,"conflictsWith":"r2"}\nDone.'
    expect(parsePhrasing(text, known)).toEqual({
      rule: 'Write no comments.',
      why: 'it is noise',
      when: '',
      sameAs: null,
      conflictsWith: 'r2',
    })
  })

  it('keeps a missing why or when as empty text and drops an id it was not shown', () => {
    expect(parsePhrasing('{"rule":"Be brief.","sameAs":"r9","conflictsWith":5}', known)).toEqual({
      rule: 'Be brief.',
      why: '',
      when: '',
      sameAs: null,
      conflictsWith: null,
    })
  })

  it('refuses anything else', () => {
    for (const text of [
      '',
      'no json here',
      '{"rule":""}',
      '{"rule":7}',
      '{"why":"x"}',
      '{"rule":"Ok.","why":3}',
      '{"rule":"Ok.","when":{}}',
      '{broken',
      '[1,2]',
    ]) {
      expect(parsePhrasing(text, known)).toBeNull()
    }
  })
})

describe('phrasingInput', () => {
  it('sends at most twelve prompts, each cut short, with the scope and the existing rules', () => {
    const prompts = Array.from({ length: 15 }, (_, i) => `${i}${'x'.repeat(500)}`)
    const sent = JSON.parse(
      phrasingInput(prompts, 'global', [{ id: 'r1', rule: 'Be brief.' }]),
    ) as {
      prompts: string[]
      scope: string
      existingRules: unknown[]
    }
    expect(sent.prompts).toHaveLength(PHRASING_PROMPTS_MAX)
    expect(sent.prompts[0].startsWith('3')).toBe(true)
    expect(sent.prompts.every((p) => p.length === PHRASING_PROMPT_CHARS)).toBe(true)
    expect(sent.scope).toBe('global')
    expect(sent.existingRules).toEqual([{ id: 'r1', rule: 'Be brief.' }])
  })
})
