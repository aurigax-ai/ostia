import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CORE_VERBS } from '@aurigax-ai/ostia-extension-sdk/manifest/coreNames'
import { describe, expect, it } from 'vitest'
import { findNoun, nounUsage, topUsage, USAGE_TABLE, usageGate } from './usageTable'

const shown = USAGE_TABLE.filter((n) => n.audience !== 'plumbing')

describe('usage table', () => {
  it('names each noun and each verb of a noun once', () => {
    const nouns = USAGE_TABLE.map((n) => n.noun)
    expect(new Set(nouns).size).toBe(nouns.length)
    for (const noun of USAGE_TABLE) {
      const verbs = (noun.verbs ?? []).map((v) => v.verb)
      expect(new Set(verbs).size, noun.noun).toBe(verbs.length)
    }
  })

  it('answers --help on every noun with its usage on stdout', () => {
    for (const noun of shown) {
      for (const help of ['--help', '-h']) {
        expect(usageGate([noun.noun, help]), noun.noun).toEqual({
          text: nounUsage(noun),
          code: 0,
        })
      }
    }
  })

  it('answers a bare noun with verbs, and an unknown verb, with its usage and exit 1', () => {
    for (const noun of shown.filter((n) => n.verbs)) {
      expect(usageGate([noun.noun]), noun.noun).toEqual({ text: nounUsage(noun), code: 1 })
      expect(usageGate([noun.noun, 'zzzzzzzzzz']), noun.noun).toEqual({
        text: `ostia ${noun.noun}: no verb 'zzzzzzzzzz'\n${nounUsage(noun)}`,
        code: 1,
      })
      for (const verb of noun.verbs ?? []) {
        expect(usageGate([noun.noun, verb.verb]), `${noun.noun} ${verb.verb}`).toBeNull()
      }
    }
  })

  it('names the nearest verb for a misspelt or shortened one', () => {
    expect(usageGate(['vault', 'ls'])).toEqual({
      text: "ostia vault: no verb 'ls'; did you mean 'ostia vault list'?",
      code: 1,
    })
    expect(usageGate(['pane', 'rea'])?.text).toBe(
      "ostia pane: no verb 'rea'; did you mean 'ostia pane read'?",
    )
    expect(usageGate(['bus', 'sned'])?.text).toBe(
      "ostia bus: no verb 'sned'; did you mean 'ostia bus send'?",
    )
    expect(usageGate(['bus', 'read'])?.text).toMatch(/^ostia bus: no verb 'read'\nusage: ostia bus/)
  })

  it('answers --help after a verb with that verb alone, but not after --', () => {
    for (const noun of shown.filter((n) => n.verbs)) {
      for (const verb of (noun.verbs ?? []).filter((v) => !v.hidden)) {
        const answer = usageGate([noun.noun, verb.verb, 'x', '--help'])
        expect(answer?.code, `${noun.noun} ${verb.verb}`).toBe(0)
        expect(answer?.text).toMatch(new RegExp(`^usage: ostia ${noun.noun} ${verb.verb}\\b`))
        expect(answer?.text.split('\n')).toHaveLength(2)
      }
    }
    expect(usageGate(['bus', 'send', '-h'])?.code).toBe(0)
    expect(usageGate(['pane', 'send', 'p', '--', '--help'])).toBeNull()
  })

  it('answers a noun that needs arguments with its usage when it has none', () => {
    for (const noun of shown.filter((n) => !n.verbs)) {
      expect(usageGate([noun.noun]), noun.noun).toEqual(
        noun.needsArgs ? { text: nounUsage(noun), code: 1 } : null,
      )
    }
  })

  it('answers a removed dotted form with one line naming the verb form', () => {
    for (const word of ['pane.list', 'pane.close', 'workspace.list', 'workspace.new']) {
      const [noun, verb] = word.split('.')
      expect(findNoun(noun)).toBeDefined()
      expect(usageGate([word]), word).toEqual({
        text: `ostia: use 'ostia ${noun} ${verb}', not '${word}'`,
        code: 1,
      })
    }
    expect(usageGate(['pane.splitRight'])).toBeNull()
  })

  it('builds the top-level help from the table, agent nouns before the human’s', () => {
    const help = topUsage()
    expect(usageGate(['--help'])).toEqual({ text: help, code: 0 })
    expect(usageGate([])).toEqual({ text: help, code: 1 })
    for (const noun of shown) expect(help).toContain(`  ${noun.noun.padEnd(12)}${noun.about}`)
    for (const noun of USAGE_TABLE.filter((n) => n.audience === 'plumbing')) {
      expect(help).not.toContain(noun.noun)
    }
    expect(help.indexOf('  pane ')).toBeLessThan(help.indexOf('  token '))
    expect(help).not.toContain('bus hook')
  })

  it('keeps one word per job: the removed forms are no verbs of any noun', () => {
    for (const [noun, verb] of [
      ['agent', 'resume'],
      ['process', 'ls'],
      ['vault', 'ls'],
      ['secret', 'ls'],
      ['ports', 'ls'],
      ['ext', 'ls'],
      ['workspace', 'import-cmux'],
    ]) {
      expect(usageGate([noun, verb]), `${noun} ${verb}`).toMatchObject({ code: 1 })
    }
    for (const word of ['info', 'cwd', 'install-polkit']) expect(findNoun(word)).toBeUndefined()
  })

  it('reserves every core noun against extension ids and verbs, and no extension-backed one', () => {
    const core = USAGE_TABLE.filter((n) => !n.extension).map((n) => n.noun)
    expect([...CORE_VERBS].sort()).toEqual([...core].sort())
  })

  it('lists exactly the commands of the extension behind an extension-backed noun', () => {
    for (const noun of USAGE_TABLE.filter((n) => n.extension)) {
      const manifest = JSON.parse(
        readFileSync(
          join(__dirname, '..', '..', 'extensions', noun.extension ?? '', 'ostia.json'),
          'utf8',
        ),
      ) as { contributes: { verb?: string; commands: { id: string }[] } }
      expect(manifest.contributes.verb, noun.noun).toBe(noun.noun)
      expect((noun.verbs ?? []).map((v) => v.verb).sort(), noun.noun).toEqual(
        manifest.contributes.commands.map((c) => c.id).sort(),
      )
    }
  })
})
