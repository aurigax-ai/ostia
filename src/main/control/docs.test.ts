import { describe, expect, it } from 'vitest'
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
})
