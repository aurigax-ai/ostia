import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importableSpecifiers } from '../../shared/artifacts/artifactRuntime'
import { CORE_SKILL_FILES, MANAGER_SKILL_FILES } from '../agents/bundledSkills'
import { docsText } from './docs'

describe('ostia docs', () => {
  it('prints the skill, a line per reference topic and the commands of the enabled extensions', () => {
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
          ],
        },
      ],
      false,
    )
    expect(text).toContain(`==> SKILL.md <==\n\n${CORE_SKILL_FILES[0].text.trimEnd()}`)
    for (const file of CORE_SKILL_FILES.slice(1)) {
      const topic = file.path.replace(/^reference\/|\.md$/g, '')
      expect(text).toMatch(
        new RegExp(`^  ostia docs ${topic} +${file.text.split('\n')[0].slice(2)}$`, 'm'),
      )
      expect(text).not.toContain(file.text.trimEnd())
    }
    expect(text).toContain('ostia system info\n      OS as JSON')
    expect(text).not.toContain(MANAGER_SKILL_FILES[0].text.trimEnd())
  })

  it('adds the manager skill for the manager', () => {
    expect(docsText([], true)).toContain(MANAGER_SKILL_FILES[0].text.trimEnd())
  })

  it('prints one reference file for a topic and names the topics for an unknown one', () => {
    const git = CORE_SKILL_FILES.find((file) => file.path === 'reference/git.md')
    expect(docsText([], false, 'git')).toBe(`==> reference/git.md <==\n\n${git?.text.trimEnd()}`)
    expect(() => docsText([], false, 'nope')).toThrow(/^unknown-topic: nope \(topics: browser, /)
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
