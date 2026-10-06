import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SKILL_DESCRIPTION_MAX = 1024

function descriptionOf(file: string): string {
  const text = readFileSync(join(__dirname, 'agent', file), 'utf8')
  return /^description: (.*)$/m.exec(text)?.[1] ?? ''
}

describe('Ostia agent skills', () => {
  it('keeps each description within the length agents are shown', () => {
    for (const file of ['ostia-skill.md', 'ostia-manager-skill.md']) {
      const description = descriptionOf(file)
      expect(description.length, file).toBeGreaterThan(0)
      expect(description.length, file).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX)
    }
  })

  it('tells an agent to ask for system packages through Ostia, never sudo', () => {
    const description = descriptionOf('ostia-skill.md')
    expect(description).toContain('ostia system install')
    expect(description).toContain('never sudo')
  })
})
