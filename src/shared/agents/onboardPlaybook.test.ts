import { skillDirective } from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import { describe, expect, it } from 'vitest'
import { ONBOARD_FILES, ONBOARD_TEXT } from './onboardPlaybook'

const STEP_LINES_MAX = 30
const INDEX_LINES_MAX = 25

const lines = (text: string): number => text.trimEnd().split('\n').length

const ROLES = ['worker', 'manager', 'reviewer']

function indexLines(): { name: string; rest: string }[] {
  return ONBOARD_TEXT.split('\n')
    .map((line) => /^- ([a-z]+): (.+)$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({ name: match[1], rest: match[2] }))
}

function indexedSteps(): string[] {
  return indexLines()
    .filter((line) => !ROLES.includes(line.name))
    .map((line) => line.name)
}

function roleSteps(): string[] {
  return indexLines()
    .filter((line) => ROLES.includes(line.name))
    .flatMap((line) => line.rest.split(', '))
}

describe('onboard playbook', () => {
  const files = ONBOARD_FILES.map((file) => file.path.replace(/^steps\/(.+)\.md$/, '$1'))

  it('lists every step file in the index and has a file for every indexed step', () => {
    expect([...indexedSteps()].sort()).toEqual([...files].sort())
  })

  it('gives every role only steps that exist, and every step to some role', () => {
    const used = new Set(roleSteps())
    expect([...used].filter((step) => !files.includes(step))).toEqual([])
    expect(files.filter((step) => !used.has(step))).toEqual([])
  })

  it('keeps the index and each step short, one heading each', () => {
    expect(lines(ONBOARD_TEXT)).toBeLessThanOrEqual(INDEX_LINES_MAX)
    for (const file of ONBOARD_FILES) {
      expect(lines(file.text), file.path).toBeLessThanOrEqual(STEP_LINES_MAX)
      expect(file.text.match(/^#{1,2} /gm), file.path).toHaveLength(1)
    }
  })

  it('holds no shell injection in the index or a step', () => {
    for (const text of [ONBOARD_TEXT, ...ONBOARD_FILES.map((file) => file.text)]) {
      expect(skillDirective(text)).toBeNull()
    }
  })
})
