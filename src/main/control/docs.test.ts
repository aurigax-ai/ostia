import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importableSpecifiers } from '../../shared/artifacts/artifactRuntime'
import { CORE_SKILL_FILES, MANAGER_SKILL_FILES } from '../agents/bundledSkills'
import { docsText } from './docs'

describe('ostia docs', () => {
  it('prints the bundled skill files and the commands of the enabled extensions', () => {
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
    for (const file of CORE_SKILL_FILES) {
      expect(text).toContain(`==> ${file.path} <==`)
      expect(text).toContain(file.text.trimEnd())
    }
    expect(text).toContain('ostia system info\n      OS as JSON')
    expect(text).not.toContain(MANAGER_SKILL_FILES[0].text.trimEnd())
  })

  it('adds the manager skill for the manager', () => {
    expect(docsText([], true)).toContain(MANAGER_SKILL_FILES[0].text.trimEnd())
  })

  it('PRT-C32 lists the same libraries in the skill and ostia docs, by name, with no /runtime path', () => {
    const skill = readFileSync(join(process.cwd(), 'src/main/agents/skills/ostia/SKILL.md'), 'utf8')
    const docs = docsText([], false)
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
