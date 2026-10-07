import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SKILL_DESCRIPTION_MAX = 1024

function skillText(file: string): string {
  return readFileSync(join(__dirname, 'agent', file), 'utf8')
}

function descriptionOf(file: string): string {
  return /^description: (.*)$/m.exec(skillText(file))?.[1] ?? ''
}

function sectionOf(file: string, heading: string): string {
  const text = skillText(file)
  const start = text.indexOf(`\n## ${heading}\n`)
  if (start === -1) return ''
  const end = text.indexOf('\n## ', start + 1)
  return text.slice(start, end === -1 ? undefined : end)
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

  it('teaches a coordinator the whole worker loop in one section, with exact commands', () => {
    const section = sectionOf('ostia-skill.md', 'Coordinating worker agents')
    for (const command of [
      'git worktree add',
      'ostia agent run claude - --name <name> --cwd <dir>',
      'ostia bus send <your id> "<branch> done|blocked: <sha> <summary>; tests:',
      'ostia whoami',
      'send-other-pane',
      'ostia pane wait <name>',
      'ostia bus wait',
      'ostia bus inbox --drain',
      'ostia pane read <name>',
      '--enter --force --confirm',
      'ostia pane key <name> enter',
      'hibernated: true',
      'ostia pane wake',
      'running: true',
      'ostia process kill <name>',
      `ostia pane.close '{"paneId":"<id>"}'`,
    ]) {
      expect(section, command).toContain(command)
    }
    expect(section).not.toMatch(/manager/i)
    expect(skillText('ostia-skill.md').match(/Coordinator pattern/g)).toBeNull()
  })
})
