import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importableSpecifiers } from '../../shared/artifacts/artifactRuntime'
import { CORE_SKILL_FILES, MANAGER_SKILL_FILES } from '../agents/bundledSkills'
import { docsText } from './docs'

describe('ostia docs', () => {
  it('prints a line per topic and the commands of the enabled extensions, not the skill', () => {
    const text = docsText(
      [
        {
          id: 'system',
          name: 'System',
          commands: [
            {
              id: 'info',
              title: 'OS as JSON',
              usage: 'info',
              palette: false,
              stdin: false,
              capabilities: [],
            },
            {
              id: 'on-hook',
              title: 'Agent hook',
              usage: 'on-hook',
              palette: false,
              stdin: true,
              capabilities: [],
            },
          ],
          agentHooks: [{ event: 'Stop', command: 'on-hook', agents: ['claude'] }],
        },
      ],
      false,
    )
    expect(text).not.toContain(CORE_SKILL_FILES[0].text.trimEnd())
    expect(text).toMatch(/^ {2}ostia docs skill +Ostia: environment and command map$/m)
    for (const file of CORE_SKILL_FILES.slice(1)) {
      const topic = file.path.replace(/^reference\/|\.md$/g, '')
      expect(text).toMatch(
        new RegExp(`^  ostia docs ${topic} +${file.text.split('\n')[0].slice(2)}$`, 'm'),
      )
      expect(text).not.toContain(file.text.trimEnd())
    }
    expect(text).toMatch(/^ {2}ostia system info {2}OS as JSON$/m)
    expect(text).not.toContain('on-hook')
    expect(text).not.toContain(MANAGER_SKILL_FILES[0].text.trimEnd())
  })

  it('adds the manager skill for the manager', () => {
    expect(docsText([], true)).toContain(MANAGER_SKILL_FILES[0].text.trimEnd())
  })

  it('prints the core skill for the skill topic', () => {
    expect(docsText([], false, 'skill')).toBe(
      `==> SKILL.md <==\n\n${CORE_SKILL_FILES[0].text.trimEnd()}`,
    )
  })

  it('prints one reference file for a topic and names the topics for an unknown one', () => {
    const git = CORE_SKILL_FILES.find((file) => file.path === 'reference/git.md')
    expect(docsText([], false, 'git')).toBe(`==> reference/git.md <==\n\n${git?.text.trimEnd()}`)
    expect(() => docsText([], false, 'nope')).toThrow(
      /^unknown-topic: nope \(topics: skill, browser, /,
    )
  })

  it('PRT-C32 lists the same libraries in the skill and ostia docs, by name, with no /runtime path', () => {
    const skill = readFileSync(
      join(process.cwd(), 'src/main/agents/skills/ostia/reference/previews.md'),
      'utf8',
    )
    const docs = docsText([], false, 'previews')
    for (const specifier of importableSpecifiers()) {
      const line = new RegExp(`^\\s*${specifier.replace(/[/@.-]/g, '\\$&')}\\s`, 'm')
      expect(skill, specifier).toMatch(line)
      expect(docs, specifier).toMatch(line)
    }
    for (const text of [skill, docs]) {
      expect(text).not.toContain('/runtime/')
      expect(text).toMatch(/import [\w{} ,]+ from '\.\/[\w-]+\.json'/)
    }
    expect(skill).toMatch(/\.html. page's module script both import them by name/)
    expect(skill).not.toMatch(/fetch\('\.\/data\.json'\)/)
  })
})
